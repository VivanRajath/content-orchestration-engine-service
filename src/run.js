import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir, repoRoot } from './paths.js';
import { readManifest, modelFor } from './config.js';
import { loadHooks, checkCommit } from './hooks.js';
import { callModel, extractJson } from './provider.js';
import { classify, selectSwarm } from './classify.js';
import { verify } from './verify.js';
import { TOOLS, dispatch } from './tools.js';
import {
  openSession, openAttempt, closeAttempt, closeSession, commitAttempt,
  revertAttempt, dirtyFiles, isRepo, listSessions, readSession, resumeBrief, git,
  attemptPaths, headSha,
  record as sessionRecord,
} from './session.js';
import { newLedger, reconcile, compile, REPORT_SYSTEM, reportPrompt } from './context.js';
import { readAgents, findAgent, frontMatter, swarmable, partition, escalatesTo, buildFixer } from './agents.js';
import { createPrompter } from './prompter.js';
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

export async function run(positional, flags, { call = callModel, prompter = null, build: knownBuild = null } = {}) {
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

  // Both halves of the safety net are git: the session branch that makes a run
  // reviewable, and the per-file revert that undoes a failed attempt. Neither
  // exists without a commit to work from — `openSession` cannot branch off
  // nothing, and `revertAttempt` has no sha to restore to, so it returns
  // silently and the failed attempt's files stay. That state used to be entered
  // without a word, and the chat reaches it by default because it passes
  // --allow-dirty.
  requireGit(root, flags);

  // Refusing to start on a dirty tree is what makes the revert safe: the only
  // work it can ever destroy is the agent's own. This guard is the precondition
  // for revertAttempt, not a convenience.
  const dirty = isRepo(root) ? dirtyFiles(root) : [];
  if (dirty.length && !flags['allow-dirty']) {
    throw new Error(
      `The working tree has ${dirty.length} uncommitted change(s).\n` +
      `  ${dirty.slice(0, 5).join('\n  ')}${dirty.length > 5 ? `\n  … and ${dirty.length - 5} more` : ''}\n\n` +
      '  A failed attempt is rolled back through git, which would destroy them.\n' +
      '  Commit or stash first, or pass --allow-dirty to accept that risk.',
    );
  }

  // The chat hands back the build state from the end of the previous turn,
  // which it has just verified. Without it every message paid for the project's
  // whole test suite twice: once to decide routing, once to check the result.
  // The post-task verify is still run for real — that is the one that gates a
  // commit, and it is never taken from a cache.
  const build = flags['skip-verify']
    ? { green: null, output: '', label: null }
    : (knownBuild ?? verify({ root }));
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
    agents,
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
    // The chat is one conversation, so it stays on one branch. Branching per
    // message stacked a new session branch on top of the last for every task —
    // ten messages, ten chained branches to clean up.
    reuseBranch: prior?.branch ?? (flags.quiet ? sessionBranchInUse(root, manifest) : null),
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
    // The caller's prompter, when there is one. The chat passes its own so a
    // checkpoint asks through the SAME readline interface — see checkpoint().
    prompter,
    askLock: { tail: Promise.resolve() },
    contextBudget: manifest.raw?.routing?.context_budget ?? 6000,
    // Canonical execution state, owned by the loop and never by a tier. This
    // is what makes a handoff survive a change of model.
    ledger: prior ? priorLedger(prior, subject) : newLedger(subject),
  };

  try {
    // A swarm is opt-in. Fanning out by default would multiply a user's token
    // bill the first time they installed two scoped agents, without them ever
    // asking for it.
    const group = flags.swarm && !named
      ? await swarmFor(ctx, { task: subject, files: repoFiles(root) })
      : null;
    if (group) {
      const result = await swarm(ctx, group, { task: subject, brief });
      // The same gate the ladder applies: a red build goes to whoever repairs
      // builds, and only then is anything committed. Without this a swarm
      // committed over a red build — every frame was closed with no verify
      // result, and "unknown" only warns.
      let build = result.build;
      if (build.green === false && result.done.length) {
        const repaired = await callBuildDoctor(ctx, result.done[0].frame, build);
        build = repaired.build;
      }
      for (const d of result.done) d.frame.verify = build;

      const outcome = result.done.length
        ? {
            status: result.failed.length || build.green === false ? 'partial' : 'done',
            tier: result.done.map((d) => d.agent.name).join(', '),
            summary: result.done.map((d) => `${d.agent.name}: ${d.result.summary}`).join('; '),
            build,
          }
        : { status: 'stopped', reason: 'every agent in the swarm failed', detail: result.failed[0]?.result?.reason };
      if (outcome.status !== 'stopped') {
        for (const d of result.done) commit(ctx, d.frame, d.result.summary);
      }
      finish(ctx, outcome);
      return outcome;
    }

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
  // How many tries an agent gets is the agent's own declaration, falling back
  // to a single routing default. The old version was a table of the four names
  // this scaffold ships, so a user's own agent silently got someone else's
  // budget — or the default, whichever the name happened to miss.
  const attemptsFor = (name) =>
    findAgent(name, ctx.agents)?.attempts ?? ctx.manifest.defaultAttempts ?? 2;
  const used = {};
  let current = tier;
  let brief = initial ?? task;
  let reason = null;

  while (current) {
    used[current] = (used[current] ?? 0) + 1;
    const limit = attemptsFor(current);

    const tierModel = modelFor(ctx.manifest, current);
    const differs = tierModel.model !== ctx.manifest.model || tierModel.provider !== ctx.manifest.provider;
    console.log(
      c.b(`▸ ${current}`) + c.d(`  attempt ${used[current]}/${limit}`) +
      (differs ? c.d(`  ${tierModel.model}`) : ''),
    );
    const frame = openAttempt(ctx.session, { tier: current, task: brief, reason, owns: agentOf(ctx, current).owns });
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
      const next = escalate(current, ctx.agents);
      // An agent that already spent its attempts is not a place to escalate
      // to. Without this, hand-written agents that name each other in a loop —
      // A escalates to B, B escalates to A — pass the task round forever, each
      // one getting "one more" attempt past its limit.
      const spent = next && (used[next] ?? 0) >= attemptsFor(next);
      if (!next || spent) {
        if (spent) warn(`${current} escalates to ${next}, which already used its attempts — stopping`);
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
 * Where an agent goes when it is out of attempts.
 *
 * The agent decides, in its own front matter. This used to be a lookup table
 * of the four names the scaffold ships, which meant a user's own agent could
 * never be escalated to — it simply was not in the table.
 */
export function escalate(name, agents) {
  const agent = Array.isArray(agents) ? agents.find((a) => a.name === name) : null;
  if (!agent) return null;
  return escalatesTo(agent, agents);
}


// ---------------------------------------------------------------------------
// Swarm
// ---------------------------------------------------------------------------

/**
 * Run a group of agents at the same time, on one shared ledger.
 *
 * Only agents that opted in AND whose scopes are provably disjoint reach here
 * — see swarmable(). That is what makes concurrent writes into a single
 * working tree safe: no two agents in a group can claim the same file.
 *
 * What they share is the ledger. Each agent's handoff report is reconciled into
 * the same record, so one agent's decisions and ruled-out approaches are
 * visible to the next round rather than dying with the attempt that learned
 * them. That is the "shared knowledge" half of a swarm; the scope split is the
 * half that stops them treading on each other.
 *
 * Model work runs concurrently; git bookkeeping does not. The index is one
 * shared mutable thing, and two agents staging at once produce a diff that
 * belongs to neither of them.
 */
export async function swarm(ctx, group, { task, brief }) {
  console.log(c.b(`▸ swarm`) + c.d(`  ${group.map((a) => a.name).join(' ∥ ')}`));

  const settled = await Promise.all(group.map(async (agent) => {
    const tierModel = modelFor(ctx.manifest, agent.name);
    const frame = await gitLock(ctx, () =>
      openAttempt(ctx.session, { tier: agent.name, task: brief, owns: agent.owns }));
    try {
      const result = await attempt({ ...ctx, tierModel, agent }, frame, brief);
      return { agent, frame, result, tierModel };
    } catch (e) {
      return { agent, frame, tierModel, result: { kind: 'failed', reason: e.message } };
    }
  }));

  const done = [];
  const failed = [];

  for (const { agent, frame, result, tierModel } of settled) {
    if (result.kind === 'done') {
      await gitLock(ctx, () => closeAttempt(ctx.session, frame, { status: 'done' }));
      ok(`${c.c(agent.name)} ${result.summary || 'done'}`);
      done.push({ agent, frame, result });
    } else {
      await gitLock(ctx, async () => {
        closeAttempt(ctx.session, frame, { status: result.kind, reason: result.reason });
        await record(ctx, { frame, tierModel, status: result.kind, reason: result.reason, result });
        // Only this agent's files. Its siblings succeeded on paths it never
        // owned, and a whole-tree reset would throw their work away too.
        revertAttempt(ctx.session, frame);
      });
      warn(`${agent.name}: ${result.reason ?? 'failed'} — its files were rolled back`);
      failed.push({ agent, frame, result });
    }
  }

  // Verify once, after the whole group. Running it per agent would race on the
  // same build directory and report each agent the others' failures.
  const build = verify({ root: ctx.root });
  return { done, failed, build };
}

/**
 * Serialise git. Model calls are the slow part and stay parallel; the index is
 * not safe to share.
 */
function gitLock(ctx, fn) {
  const queue = ctx.gitQueue ?? Promise.resolve();
  const next = queue.then(fn, fn);
  ctx.gitQueue = next.then(() => undefined, () => undefined);
  return next;
}

/** The registered agent, or a minimal stand-in for one only named in DUTIES. */
function agentOf(ctx, name) {
  return findAgent(name, ctx.agents) ?? { name, dir: join(ctx.dir, 'agents', name), owns: [], role: '' };
}

/**
 * The agents a task should fan out to, or null when it is one agent's job.
 *
 * Selection is about the TASK. The file-ownership pass below is only a
 * fallback, because on its own it answers a different question — "does this
 * agent own anything in this repo" — and so fanned out to agents the task never
 * touched, at one model call each.
 */
export async function swarmFor(ctx, { task = '', files = [] } = {}) {
  const groups = swarmable(ctx.agents).filter((g) => g.length > 1);
  if (!groups.length) return null;
  const group = groups[0];

  const picked = await selectSwarm({ task, agents: group, manifest: ctx.manifest, call: ctx.call });
  if (picked) {
    const chosen = group.filter((a) => picked.includes(a.name));
    // One agent named is a real answer: it means this is not swarm work.
    return chosen.length > 1 ? chosen : null;
  }

  const { claims } = partition(group, files);
  const busy = group.filter((a) => (claims.get(a.name) ?? []).length);
  return busy.length > 1 ? busy : null;
}

// ---------------------------------------------------------------------------
// One attempt
// ---------------------------------------------------------------------------

async function attempt(ctx, frame, brief) {
  const messages = [{ role: 'user', content: brief }];
  const system = prompt(ctx, ctx.agent ?? findAgent(frame.tier, ctx.agents) ?? { name: frame.tier, dir: join(ctx.dir, 'agents', frame.tier), owns: [] });
  const toolCtx = { ...ctx, tier: frame.tier, touched: new Set() };
  // Checkpoints are asked by tools.js BEFORE the write or command, through this.
  // A "no" is remembered for the attempt, so a model retrying the same thing
  // gets the same answer instead of asking the human again and again.
  const refused = new Set();
  toolCtx.approve = async (cp) => {
    const key = `${cp.hook}\n${cp.reason}`;
    if (refused.has(key)) return false;
    const yes = await checkpoint(ctx, cp);
    if (!yes) refused.add(key);
    return yes;
  };
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
      const out = await dispatch(call, toolCtx);
      info(`  ${out.isError ? c.y('✗') : c.g('✓')} ${call.name}${describe(call)}`);
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
  // Whichever agent declares `fixes_build`, not whichever is called
  // "build-doctor". A repo with no such agent simply has nobody to delegate to.
  const fixer = buildFixer(ctx.agents);
  if (!fixer) return { ok: false, build };

  console.log(c.b(`▸ ${fixer.name}`) + c.d('  (nested — returns control)'));
  const brief = [
    'The build is red. Get it green. That is the entire job.',
    '\nYou were called from a feature task in progress. Do NOT implement any part of it.',
    `\n## Command\n\n${build.label ?? 'unknown'}`,
    `\n## Output\n\n\`\`\`\n${build.output}\n\`\`\``,
  ].join('\n');

  const frame = openAttempt(ctx.session, { tier: fixer.name, task: brief, parent, reason: 'red build', owns: fixer.owns });
  const result = await attempt({ ...ctx, agent: fixer, tierModel: modelFor(ctx.manifest, fixer.name) }, frame, brief);
  const after = verify({ root: ctx.root });
  closeAttempt(ctx.session, frame, { status: after.green ? 'done' : 'failed', verify: after });

  if (after.green) ok(`${fixer.name}: green — control returns to the calling agent`);
  else warn(`${fixer.name} could not reach a green build`);
  return { ok: Boolean(after.green), build: after, result };
}

function commit(ctx, frame, summary) {
  if (ctx.manifest.raw?.git?.auto_commit === false) return;
  // The same set commitAttempt will stage. Gating on frame.touched alone left
  // anything a run_command wrote unscanned, while the commit took it anyway.
  const files = attemptPaths(ctx.session, frame);
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
  // Agents in a swarm run concurrently; two "Allow?" prompts at once would
  // interleave on one terminal and one answer would go to the wrong question.
  // Every attempt shares ctx.askLock (an object, so the spread keeps it shared).
  const lock = ctx.askLock ?? { tail: Promise.resolve() };
  const turn = lock.tail.then(() => ask(ctx, cp));
  lock.tail = turn.catch(() => {});
  return turn;
}

async function ask(ctx, cp) {
  warn(`checkpoint — ${cp.hook}: ${cp.reason}`);
  if (ctx.autoApprove) { info('  approved by --yes'); return true; }

  // Inside the chat, ask through the chat's own prompter. Opening a second
  // readline interface on stdin here is what made the chat stop accepting
  // input: closing this one paused stdin and switched raw mode off underneath
  // the chat's interface, which then never saw another keystroke.
  if (ctx.prompter) return ctx.prompter.confirm(c.b('Allow?'), false);

  if (!ctx.interactive) {
    info('  not a terminal, and --yes was not passed — declining');
    return false;
  }
  // A standalone `jr-arch run` has no prompter of its own, so it makes one for
  // this question and closes it — nothing else is reading stdin at that point.
  const own = createPrompter();
  try {
    return await own.confirm(c.b('Allow?'), false);
  } finally {
    own.close();
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
  if (outcome.status === 'done' || outcome.status === 'partial') {
    if (outcome.status === 'partial') warn('Some agents failed; their files were rolled back.');
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

/**
 * Refuse to run where a failed attempt could not be undone.
 *
 * `--no-git` is the way to say you accept that, and it has to be typed: the
 * cost of guessing wrong is the user's files, and "it seemed to work" is how
 * someone finds out afterwards.
 */
function requireGit(root, flags) {
  if (flags['no-git']) {
    warn('Running without git: no session branch, and a failed attempt cannot be rolled back.');
    return;
  }

  if (!isRepo(root)) {
    throw new Error([
      `${root} is not a git repository.`,
      '  Every run works on its own branch, and a failed attempt is undone with git.',
      '  Neither is possible here, so a failed attempt would leave its edits behind.',
      '',
      '  Start one:   git init && git add -A && git commit -m "initial commit"',
      '  Or accept the risk:  --no-git',
    ].join(NEWLINE));
  }

  if (!headSha(root)) {
    throw new Error([
      'This repository has no commits yet.',
      '  There is nothing to branch from and nothing to roll back to, so a failed',
      '  attempt would leave its edits in your working tree.',
      '',
      '  Make the first commit:  git add -A && git commit -m "initial commit"',
      '  Or accept the risk:     --no-git',
    ].join(NEWLINE));
  }
}

/** The current branch, if it is already one of our session branches. */
function sessionBranchInUse(root, manifest) {
  if (!isRepo(root)) return null;
  const prefix = manifest.raw?.git?.branch_prefix ?? 'jr-arch';
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], { root, check: false });
  return current && current.startsWith(`${prefix}/session-`) ? current : null;
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
