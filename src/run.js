import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { agentDir, repoRoot } from './paths.js';
import { readManifest, modelFor } from './config.js';
import { loadHooks, checkCommit } from './hooks.js';
import { callModel, extractJson } from './provider.js';
import { classify } from './classify.js';
import { verify } from './verify.js';
import { TOOLS, dispatch } from './tools.js';
import {
  openSession, openAttempt, closeAttempt, closeSession, commitAttempt,
  revertAttempt, dirtyFiles, isRepo, listSessions, readSession, resumeBrief,
  record as sessionRecord,
} from './session.js';
import { newLedger, reconcile, compile, REPORT_SYSTEM, reportPrompt } from './context.js';
import { readAgents, findAgent, frontMatter } from './agents.js';
import { c, ok, info, warn } from './util.js';

/**
 * The execution loop.
 *
 * Everything below is the ladder DUTIES.md describes, and DUTIES.md — not this
 * file — is the contract. The escalation rules are read from the user's own
 * copy at prompt time; what is hard-coded here is only the machinery that
 * makes them happen: attempt counting, handoff routing, and the nesting that
 * lets build-doctor return control instead of inheriting the task.
 */

const DEFAULT_MAX_STEPS = 40;

/** Consecutive tool-free replies before an attempt is declared stalled. */
const IDLE_LIMIT = 3;

export async function run(positional, flags, { call = callModel } = {}) {
  const root = repoRoot();
  const dir = agentDir();
  const task = (positional ?? []).join(' ').trim() || (typeof flags.task === 'string' ? flags.task : '');

  if (!existsSync(join(dir, 'agent.yaml'))) {
    throw new Error('No .gitagent/ found. Run `jr-arch init` first.');
  }

  // Resuming replaces the task with the prior session's, so the check for a
  // missing task comes after it.
  const prior = flags.resume ? loadPrior(flags.resume) : null;
  const brief = prior ? resumeBrief(prior) : task;
  const subject = prior ? prior.task : task;
  if (!subject) throw new Error('Usage: jr-arch run "<task>"');

  const manifest = readManifest();
  const hooks = loadHooks(dir, { reload: true });
  for (const note of hooks.notes) warn(note);

  // Installed agents are whatever is in agents/, read from their own front
  // matter. The manifest no longer decides which exist — a directory does.
  const agents = readAgents(dir);
  if (!agents.length) {
    throw new Error([
      'No agents installed.',
      '  Add one:  jr-arch add-agent <git-url>',
      '  Or scaffold the defaults:  jr-arch init --force',
    ].join(NEWLINE));
  }
  const tiers = agents.map((a) => a.name);
  const maxSteps = manifest.raw?.routing?.max_steps ?? DEFAULT_MAX_STEPS;

  // Failed attempts are reverted with `git reset --hard`. Refusing to start on
  // a dirty tree is what makes that safe: the only work it can ever destroy is
  // the agent's own. This guard is the precondition for revertAttempt, not a
  // convenience — do not weaken it without removing that.
  const dirty = isRepo(root) ? dirtyFiles(root) : [];
  if (dirty.length && !flags['allow-dirty']) {
    throw new Error(
      `The working tree has ${dirty.length} uncommitted change(s).\n` +
      `  ${dirty.slice(0, 5).join('\n  ')}${dirty.length > 5 ? `\n  … and ${dirty.length - 5} more` : ''}\n\n` +
      '  Failed attempts are rolled back with git reset --hard, which would destroy them.\n' +
      '  Commit or stash first, or pass --allow-dirty to accept that risk.',
    );
  }

  const build = flags['skip-verify'] ? { green: null, output: '', label: null } : verify({ root });
  // Chat repeats this loop once per message, so the standing facts — model,
  // agent list, build state — are banner material for a one-off `run` and
  // noise in a conversation that already showed them at startup.
  if (!flags.quiet) banner(manifest, subject, build, tiers);
  if (prior) {
    info(`resuming   ${c.c(prior.id)} ${c.d(`(${prior.attempts.length} prior attempt(s), ${prior.status})`)}`);
    console.log();
  }

  // An explicitly named agent skips classification entirely — no model call,
  // and no chance of being routed somewhere the user did not ask for.
  const named = typeof flags.agent === 'string' ? findAgent(flags.agent, agents) : null;
  if (typeof flags.agent === 'string' && !named) {
    throw new Error(`No agent "${flags.agent}". Installed: ${tiers.join(', ')}`);
  }

  const entry = named
    ? { tier: named.name, confidence: 1, reason: 'you named this agent', source: 'explicit' }
    : await classify({
    task: subject,
    buildGreen: build.green,
    files: repoFiles(root),
    manifest,
    dir,
    call,
  });
  if (flags.quiet) {
    info(`${c.c(entry.tier)} ${c.d(entry.source === 'explicit' ? '' : `· ${entry.reason}`)}`);
  } else {
    info(`agent      ${c.c(entry.tier)}  ${c.d(`(${entry.source}, confidence ${entry.confidence})`)}`);
    info(`why        ${entry.reason}`);
    console.log();
  }

  if (flags['dry-run']) {
    info('Dry run — no session opened, nothing written.');
    return { tier: entry.tier, dryRun: true };
  }

  const session = openSession({
    root,
    task: subject,
    // A resumed run stays on the branch the first one made. Branching again
    // would strand the earlier attempts on a branch nobody looks at.
    reuseBranch: prior?.branch ?? null,
    branch: manifest.raw?.git?.session_branch !== false && isRepo(root),
    prefix: manifest.raw?.git?.branch_prefix ?? 'jr-arch',
  });
  session.keyEnv = manifest.keyEnv;
  if (!flags.quiet) {
    if (session.branched) info(`branch     ${c.c(session.branch)}`);
    info(`session    ${c.d(session.dir)}`);
    console.log();
  }

  const ctx = {
    root, dir, session, hooks, manifest, tiers, agents, maxSteps, call,
    interactive: process.stdin.isTTY && process.stdout.isTTY,
    // Streaming is a terminal affordance. Piped output has nobody watching it
    // arrive, and --no-stream exists for a run whose log is being captured.
    stream: Boolean(process.stdout.isTTY) && !flags['no-stream'],
    autoApprove: Boolean(flags.yes),
    contextBudget: manifest.raw?.routing?.context_budget ?? 6000,
    // Canonical execution state, owned by the loop and never by a tier. This
    // is what makes a handoff survive a change of model.
    ledger: prior ? priorLedger(prior, subject) : newLedger(subject),
  };

  try {
    const outcome = await ladder(ctx, { tier: entry.tier, task: subject, brief });
    finish(ctx, outcome);
    return outcome;
  } catch (err) {
    closeSession(session, { status: 'error', summary: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/**
 * Walk the tiers until one finishes, or the terminal tier gives up.
 *
 * Retry limits are per tier, not per run: DUTIES.md gives junior and senior two
 * attempts each, and a junior that burned both still arrives at a senior with a
 * full budget. `senior-dev` is terminal — it escalates to the human, never to
 * another agent, because there is nothing above it and looping is worse than
 * asking.
 */
export async function ladder(ctx, { tier, task, brief: initial = null }) {
  const limits = {
    'junior-dev': ctx.manifest.juniorRetryLimit ?? 2,
    'ui-editor': ctx.manifest.juniorRetryLimit ?? 2,
    'senior-dev': ctx.manifest.seniorRetryLimit ?? 2,
    'build-doctor': 3,
  };
  const used = {};
  let current = tier;
  let brief = initial ?? task;
  let reason = null;

  while (current) {
    used[current] = (used[current] ?? 0) + 1;
    const limit = limits[current] ?? 2;

    const tierModel = modelFor(ctx.manifest, current);
    const differs = tierModel.model !== ctx.manifest.model || tierModel.provider !== ctx.manifest.provider;
    console.log(
      c.b(`▸ ${current}`) + c.d(`  attempt ${used[current]}/${limit}`) +
      (differs ? c.d(`  ${tierModel.model}`) : ''),
    );
    const frame = openAttempt(ctx.session, { tier: current, task: brief, reason });
    const result = await attempt({ ...ctx, tierModel }, frame, brief);

    if (result.kind === 'done') {
      const check = await verifyAndGate(ctx);
      if (check.ok) {
        closeAttempt(ctx.session, frame, { status: 'done', verify: check.build });
        commit(ctx, frame, result.summary);
        return { status: 'done', tier: current, summary: result.summary, build: check.build };
      }
      // Claimed done on a red build. That is a build-doctor problem, and the
      // tier keeps the task — build-doctor hands control back, it does not
      // inherit the work.
      closeAttempt(ctx.session, frame, { status: 'failed', reason: 'verify failed', verify: check.build });
      const repaired = await callBuildDoctor(ctx, frame, check.build);
      if (repaired.ok) {
        commit(ctx, frame, result.summary);
        return { status: 'done', tier: current, summary: result.summary, build: repaired.build };
      }
      reason = `the build is red after your change: ${truncate(check.build.output, 800)}`;
    } else if (result.kind === 'handoff') {
      closeAttempt(ctx.session, frame, { status: 'handoff', reason: result.reason });
      await record(ctx, { frame, tierModel, status: 'handoff', reason: result.reason, result });
      // A handoff carries its record forward but does not keep the edits: the
      // receiving tier decides its own approach, and half a junior's attempt
      // sitting in the tree is not a starting point, it is a trap.
      revertAttempt(ctx.session, frame);
      warn(`handoff → ${result.to}: ${result.reason}`);
      current = result.to;
      brief = compile(ctx.ledger, { to: result.to, reason: result.reason, budget: ctx.contextBudget });
      reason = result.reason;
      continue;
    } else {
      closeAttempt(ctx.session, frame, { status: 'failed', reason: result.reason });
      await record(ctx, { frame, tierModel, status: 'failed', reason: result.reason, result });
      revertAttempt(ctx.session, frame);
      warn(`attempt failed: ${result.reason}`);
      reason = result.reason;
    }

    if (used[current] >= limit) {
      const next = escalate(current, ctx.tiers);
      if (!next) {
        return {
          status: 'stopped',
          tier: current,
          reason: `${current} is terminal and used ${used[current]} attempts`,
          detail: reason,
        };
      }
      warn(`${current} exhausted ${used[current]} attempts → ${next}`);
      brief = compile(ctx.ledger, { to: next, reason: reason ?? 'attempts exhausted', budget: ctx.contextBudget });
      current = next;
    } else {
      brief = compile(ctx.ledger, { to: current, reason: reason ?? 'retry', budget: ctx.contextBudget });
    }
  }

  return { status: 'stopped', reason: 'no tier available' };
}

/**
 * Where a tier goes when it is out of attempts.
 *
 * ui-editor escalates to junior-dev, its peer, because a ui task that will not
 * resolve is usually logic work wearing a stylesheet. senior-dev returns null:
 * terminal means the human hears about it.
 */
export function escalate(tier, tiers) {
  const next = { 'ui-editor': 'junior-dev', 'junior-dev': 'senior-dev', 'build-doctor': 'senior-dev' }[tier] ?? null;
  if (!next) return null;
  return tiers.includes(next) ? next : tiers.includes('senior-dev') ? 'senior-dev' : null;
}

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

async function attempt(ctx, frame, brief) {
  const messages = [{ role: 'user', content: brief }];
  const system = prompt(ctx, ctx.agent ?? findAgent(frame.tier, ctx.agents) ?? { name: frame.tier, dir: join(ctx.dir, 'agents', frame.tier), owns: [] });
  const toolCtx = { ...ctx, tier: frame.tier, touched: new Set() };
  let idle = 0;
  // commit() gates on the files this attempt actually wrote, so the set has to
  // live on the frame, not only in the tool context that closes over it.
  frame.touched = toolCtx.touched;

  while (frame.steps < ctx.maxSteps) {
    frame.steps++;

    let reply;
    const stream = ctx.stream ? streamWriter() : null;
    try {
      reply = await ctx.call(ctx.tierModel ?? ctx.manifest, {
        system, messages, tools: TOOLS,
        ...(stream ? { onDelta: stream.write } : {}),
      });
    } catch (e) {
      stream?.end();
      return { kind: 'failed', reason: `model call failed: ${e.message}` };
    }
    stream?.end();

    // Already shown live when streaming; printing it again would double it.
    if (!stream && reply.text?.trim()) info(c.d(`  ${truncate(reply.text.trim(), 300)}`));

    if (!reply.toolCalls.length) {
      // No tool call and no done(). A capable model ends with done; one that
      // cannot call tools at all will never edit a file, which is what doctor
      // exists to catch before a run rather than during one.
      if (frame.steps === 1) {
        return {
          kind: 'failed',
          reason: 'the model replied with prose and called no tool. Run `jr-arch doctor` — tiered mode needs tool calling.',
        };
      }
      // One nudge is worth paying for; a model that will not act does not
      // start after the third. Without this an attempt spends its whole
      // step budget on "Continue" and bills the user for every round trip.
      if (++idle >= IDLE_LIMIT) {
        return { kind: 'failed', reason: `stopped acting — ${idle} replies in a row with no tool call` };
      }
      messages.push({ role: 'assistant', text: reply.text });
      messages.push({ role: 'user', content: 'Continue, or call done() if the task is complete.' });
      continue;
    }
    idle = 0;

    messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });

    const results = [];
    let control = null;
    for (const call of reply.toolCalls) {
      if (control) {
        // Everything after a control call in the same turn is dropped: the
        // attempt is over, and running an edit after done() would land changes
        // nobody verified.
        results.push({ id: call.id, name: call.name, content: 'Skipped — the attempt already ended.', isError: true });
        continue;
      }
      const out = dispatch(call, toolCtx);
      info(`  ${out.isError ? c.y('✗') : c.g('✓')} ${call.name}${describe(call)}`);

      for (const cp of out.checkpoints ?? []) {
        const approved = await checkpoint(ctx, cp);
        if (!approved) return { kind: 'failed', reason: `human checkpoint declined: ${cp.reason}` };
      }
      results.push({ id: call.id, name: call.name, content: out.content, isError: out.isError });
      if (out.control) control = out.control;
    }

    messages.push({ role: 'tool', results });

    if (control?.kind === 'done') return { kind: 'done', summary: control.summary, touched: toolCtx.touched };
    if (control?.kind === 'handoff') return { kind: 'handoff', to: control.to, reason: control.reason };
  }

  return { kind: 'failed', reason: `hit the ${ctx.maxSteps}-step ceiling without finishing` };
}

// ---------------------------------------------------------------------------
// Verify, build-doctor, commit
// ---------------------------------------------------------------------------

async function verifyAndGate(ctx) {
  const build = verify({ root: ctx.root });
  if (build.green === false) {
    warn(`verify failed (${build.label})`);
    return { ok: false, build };
  }
  if (build.green === null && build.reason) info(c.d(`  verify skipped — ${build.reason}`));
  else if (build.green) ok(`verify passed (${build.label})`);
  return { ok: true, build };
}

/**
 * Build doctor as a NESTED attempt.
 *
 * It gets the build green and returns control to the calling tier at the same
 * step. It never inherits the feature task — the frame it runs in carries
 * build-doctor as its tier so the scope fence and the persona both match, and
 * the parent frame is untouched underneath it.
 */
async function callBuildDoctor(ctx, parent, build) {
  if (!ctx.tiers.includes('build-doctor')) return { ok: false, build };

  console.log(c.b('▸ build-doctor') + c.d('  (nested — returns control)'));
  const brief = [
    'The build is red. Get it green. That is the entire job.',
    '\nYou were called from a feature task in progress. Do NOT implement any part of it.',
    `\n## Command\n\n${build.label ?? 'unknown'}`,
    `\n## Output\n\n\`\`\`\n${build.output}\n\`\`\``,
  ].join('\n');

  const frame = openAttempt(ctx.session, { tier: 'build-doctor', task: brief, parent, reason: 'red build' });
  const result = await attempt(ctx, frame, brief);
  const after = verify({ root: ctx.root });
  closeAttempt(ctx.session, frame, { status: after.green ? 'done' : 'failed', verify: after });

  if (after.green) ok('build-doctor: green — control returns to the calling tier');
  else warn('build-doctor could not reach a green build');
  return { ok: Boolean(after.green), build: after, result };
}

function commit(ctx, frame, summary) {
  if (ctx.manifest.raw?.git?.auto_commit === false) return;
  const files = [...(frame.touched ?? [])];
  const gate = checkCommit(files, frame.verify?.green ?? null, ctx.hooks, { root: ctx.root });
  if (!gate.allowed) {
    for (const b of gate.blocked) warn(`commit blocked by ${b.hook}: ${b.reason}`);
    return;
  }
  const sha = commitAttempt(ctx.session, frame, `${frame.tier}: ${truncate(summary, 68)}\n\nvia jr-arch`);
  if (sha) info(`commit     ${c.c(sha.slice(0, 7))}`);
}

// ---------------------------------------------------------------------------
// Human checkpoints
// ---------------------------------------------------------------------------

/**
 * DUTIES.md always-stop cases reach here as hook warnings with checkpoint:true.
 *
 * Non-interactive declines rather than proceeding. A dependency change waved
 * through because the run happened to be in CI is precisely the outcome that
 * checkpoint list exists to prevent, and --yes has to be typed by a person.
 */
async function checkpoint(ctx, cp) {
  warn(`checkpoint — ${cp.hook}: ${cp.reason}`);
  if (ctx.autoApprove) { info('  approved by --yes'); return true; }
  if (!ctx.interactive) {
    info('  not a terminal, and --yes was not passed — declining');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  ${c.b('Allow?')} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * The agent's own identity, and nothing the harness invented.
 *
 * There is deliberately no global SOUL.md or RULES.md prepended here. An agent
 * is a self-contained unit a user can pull from any URL; injecting identity
 * the harness owns into every one of them makes the harness the co-author of
 * agents it did not write, and means a pulled agent's own file no longer
 * decides how it behaves.
 *
 * Shared constraints live in `hooks/hooks.yaml`, which is enforced rather than
 * suggested, and in DUTIES.md, which is the routing contract between agents
 * and is included only when the user keeps one.
 */
function prompt(ctx, agent) {
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  const { body: soul } = frontMatter(read(join(agent.dir, 'SOUL.md')));
  const duties = read(join(ctx.dir, 'DUTIES.md'));
  const others = ctx.agents.filter((a) => a.name !== agent.name);

  return [
    soul,
    read(join(agent.dir, 'RULES.md')),
    duties ? ['# Duties and escalation', '', duties].join(NEWLINE) : '',
    [
      '# How you operate',
      '',
      `You are \`${agent.name}\`.`,
      others.length
        ? `Other agents installed: ${others.map((a) => `${a.name}${a.role ? ` (${a.role})` : ''}`).join(', ')}.`
        : 'You are the only agent installed, so there is nobody to hand off to.',
      agent.owns.length ? `Your scope: ${agent.owns.join(', ')}.` : '',
      '',
      'Work through the tools. Read before you write. write_file takes the COMPLETE',
      'new contents of a file, never a patch or a fragment.',
      '',
      'run_command takes argv as an array of separate strings and runs with no shell,',
      'so pipes, redirects, and && are literal arguments, not operators.',
      '',
      'Guardrails are enforced by the harness, not by these instructions. If a call is',
      'blocked you will be told which hook stopped it and why — read the reason and',
      'either fix the approach or hand off. Retrying the identical call will fail again.',
      '',
      'Call done() when the task is complete, with one or two lines saying what changed',
      'and where.',
      others.length
        ? 'Call handoff() the moment the task exceeds your scope — that is the design working, not a failure.'
        : '',
    ].filter(Boolean).join(NEWLINE),
  ].filter((s) => s.trim()).join(`${NEWLINE}${NEWLINE}---${NEWLINE}${NEWLINE}`);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function banner(manifest, task, build, tiers) {
  console.log();
  info(`model      ${manifest.model} ${c.d(`(${manifest.provider})`)}`);
  info(`tiers      ${tiers.join(', ')}`);
  const state = build.green === true ? c.g('green') : build.green === false ? c.r('red') : c.y('unknown');
  info(`build      ${state}${build.label ? c.d(`  ${build.label}`) : ''}${build.reason ? c.d(`  — ${build.reason}`) : ''}`);
  console.log();
  console.log(c.b('task'));
  console.log(`  ${task}`);
  console.log();
}

function finish(ctx, outcome) {
  console.log();
  if (outcome.status === 'done') {
    ok(c.b(outcome.summary || 'Done.'));
    if (ctx.session.branched) info(`on branch ${c.c(ctx.session.branch)} — review, then merge or discard`);
  } else {
    warn(c.b('Stopped and escalated to you.'));
    if (outcome.reason) info(outcome.reason);
    if (outcome.detail) info(truncate(outcome.detail, 600));
    info(`transcript ${c.d(ctx.session.dir)}`);
  }
  closeSession(ctx.session, { status: outcome.status, summary: outcome.summary ?? outcome.reason ?? '' });
  console.log();
}

/**
 * Write streamed tokens into the indented tool log without breaking it.
 *
 * The model's prose is dimmed and indented to match the tool lines around it,
 * so a long attempt reads as one column rather than as output fighting the
 * layout. Indentation is applied per newline as tokens arrive, because a delta
 * can end mid-line and the next one continues it.
 */
/**
 * Find the session a --resume refers to.
 *
 * `--resume` with no id takes the most recent, which is what someone re-running
 * a run that just stopped almost always means. A wrong id lists the real ones
 * rather than saying "not found" and leaving the user to go and read a
 * directory themselves.
 */
function loadPrior(flag) {
  const ids = listSessions();
  if (!ids.length) throw new Error('No sessions to resume — .gitagent/.session/ is empty.');

  const id = flag === true ? ids[0] : String(flag);
  const prior = readSession(id);
  if (!prior) {
    const available = ids.slice(0, 8).map((s) => `    ${s}`).join(NEWLINE);
    throw new Error(`No session "${id}".${NEWLINE}  Available:${NEWLINE}${available}`);
  }
  if (prior.status === 'done') {
    throw new Error(`Session ${id} finished successfully — there is nothing to resume.`);
  }
  return prior;
}

/**
 * Ask the finishing tier for its handoff report, then merge it into the ledger.
 *
 * A SECOND model call, deliberately separate from the task turn. A model asked
 * for the work and the report in one prompt writes an optimistic report and
 * drifts out of the task; splitting them costs one small call per handoff and
 * is the difference between a usable record and a victory lap.
 *
 * The reply is treated as CLAIMS. reconcile() stamps only what the harness
 * itself observed — which files were really written, whether the build really
 * went green — and marks the rest unverified. A tier cannot write its own
 * provenance, and cannot delete a failed attempt from the record.
 */
async function record(ctx, { frame, tierModel, status, reason, result }) {
  const observed = {
    touched: [...(frame.touched ?? [])],
    diffLines: frame.diff ? frame.diff.split(NEWLINE).length : 0,
    green: frame.verify?.green ?? null,
    build: frame.verify ?? null,
    reason,
  };

  let claims = {};
  try {
    const reply = await ctx.call(tierModel ?? ctx.manifest, {
      system: REPORT_SYSTEM,
      messages: [{ role: 'user', content: reportPrompt({ tier: frame.tier, status, reason, observed }) }],
      maxTokens: 800,
      temperature: 0,
    });
    claims = extractJson(reply.text) ?? {};
  } catch (e) {
    // A failed report costs context, not the run. The engine-observed half of
    // the record still lands, which is the half that cannot be faked anyway.
    info(c.d(`  handoff report unavailable (${truncate(e.message, 80)})`));
  }

  reconcile(ctx.ledger, { tier: frame.tier, claims, observed, status });
  sessionRecord(ctx.session, 'ledger', {
    tier: frame.tier,
    status,
    decisions: ctx.ledger.decisions.length,
    failed: ctx.ledger.failed.length,
    artifacts: ctx.ledger.artifacts.length,
  });
}

/** Rebuild a ledger from a prior session, so a resume keeps what it learned. */
function priorLedger(prior, task) {
  const ledger = newLedger(task);
  for (const a of prior.attempts) {
    if (a.status === 'done') continue;
    ledger.failed.push({
      tier: a.tier,
      approach: `attempt ${a.n}`,
      why: a.reason ?? 'no reason recorded',
      diffLines: a.diff ? a.diff.split(NEWLINE).length : 0,
      recorded_by: 'previous session',
      recorded_at: new Date().toISOString(),
      verified: true,
    });
  }
  return ledger;
}

const NEWLINE = String.fromCharCode(10);

function streamWriter(indent = '    ') {
  let started = false;
  let atLineStart = true;

  // Colour per delta, not per character. Wrapping every letter in its own
  // escape pair costs about nine bytes a character and makes the raw stream
  // unreadable in a captured log for no visible gain.
  const write = (text) => {
    if (!text) return;
    started = true;
    const segments = String(text).split(NEWLINE);
    segments.forEach((segment, i) => {
      if (i > 0) { process.stdout.write(NEWLINE); atLineStart = true; }
      if (!segment) return;
      if (atLineStart) { process.stdout.write(indent); atLineStart = false; }
      process.stdout.write(c.d(segment));
    });
  };

  return {
    write,
    end() { if (started && !atLineStart) process.stdout.write(NEWLINE); },
  };
}

const truncate = (s, n) => {
  const t = String(s ?? '').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

function describe(call) {
  if (call.input?.path) return c.d(`  ${call.input.path}`);
  if (Array.isArray(call.input?.command)) return c.d(`  ${call.input.command.join(' ')}`);
  if (call.input?.to) return c.d(`  → ${call.input.to}`);
  return '';
}

function repoFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length > 500 || depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['.git', 'node_modules', 'dist', 'build', '.next', 'target'].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else out.push(p.slice(root.length + 1).split('\\').join('/'));
    }
  };
  walk(root, 0);
  return out;
}
