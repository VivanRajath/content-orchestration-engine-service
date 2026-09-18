import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir, repoRoot } from './paths.js';
import {
  readManifest, modelFor, setModelMaxTokens, setTierMaxTokens,
  savedConnections, addSavedKey, setTierConnection,
} from './config.js';
import { requiresKey } from './provider.js';
import { readAgents, findAgent } from './agents.js';
import { dirtyFiles, isRepo, git } from './session.js';
import { verify } from './verify.js';
import { run } from './run.js';
import { createPrompter } from './prompter.js';
import { onboard, obtainKey, pickModel, setModel, keepModel, ensureRepo } from './onboard.js';
import { promptMode } from './generate.js';
import { newAgent, newGuard, checkAll, printCheck, pathsFor, DEV_HELP } from './dev.js';
import { smokeTest, printSmoke } from './smoke.js';
import { printTree } from './tree.js';
import { writeKey, ensureIgnored, nextKeyEnv } from './env.js';
import { showLimits, suggestedCap, probeModel, DEFAULT_CAP } from './limits.js';
import { listModels, providerFor } from './providers.js';
import { c, ok, info, warn } from './util.js';

/**
 * `jr-arch` with no arguments: the whole product, as a conversation.
 *
 * First run walks through setup. After that it is a chat with three modes:
 *
 *   /chat     type a task, an agent edits the code
 *   /prompt   describe what you need, agents are written for you
 *   /dev      write agents and guardrails yourself, test them
 *
 * Every task still goes through `run()` — the same ladder, the same guards, the
 * same session branch. Chat is a front door onto the loop, never a second
 * execution path, because a second path is a second place for the hooks to be
 * missing.
 */

const MODES = {
  chat: { label: 'chat', hint: 'type a task · /help' },
  dev: { label: 'dev', hint: '/new · /guard · /check · /smoke · @agent task' },
};

const HELP = `
  ${c.b('Modes')}
  ${c.c('/chat')}            type a task, an agent edits the code
  ${c.c('/prompt')}          describe what you need, agents are written for you
  ${c.c('/dev')}             write agents and guardrails yourself

  ${c.b('Tasks')}
  ${c.d('<task>')}           the right agent picks it up
  ${c.c('@name <task>')}     give it to one agent

  ${c.b('Setup')}
  ${c.c('/key')}             add an API key (as many as you like), or change one
  ${c.c('/models')}          switch model, or put one agent on another key
  ${c.c('/limits')}          rate limits, and how many tokens each agent may use
  ${c.c('/agents')}          installed agents
  ${c.c('/tree')}            where every file is
  ${c.c('/smoke [name]')}    check an agent actually works

  ${c.b('Repo')}
  ${c.c('/status')}          branch, build, uncommitted files
  ${c.c('/undo')}            roll the last turn back
  ${c.c('/exit')}            leave
`;

export async function chat(positional, flags, { call, prompter: given, fetchImpl = fetch } = {}) {
  const root = repoRoot();
  const dir = agentDir();
  const prompter = given ?? createPrompter();
  const interactive = Boolean(given) || (process.stdin.isTTY && process.stdout.isTTY);

  try {
    // --- first run ----------------------------------------------------------
    let mode = typeof flags.mode === 'string' && MODES[flags.mode] ? flags.mode : 'chat';
    let models = [];
    // Carried between turns so the suite is not run twice per message.
    let lastBuild = null;
    // Whether this session has said "go ahead without git". Asked, never assumed.
    let noGit = false;
    let gitState = null;

    // A key is missing only when the model it belongs to actually needs one.
    // This used to special-case the name OLLAMA_API_KEY, so a local
    // OpenAI-compatible server — which authenticates nothing — looked unset on
    // every launch and sent the user back through onboarding.
    const needsSetup = !existsSync(join(dir, 'agent.yaml')) || missingKeys(dir).length > 0;

    if (needsSetup) {
      // Setup asks questions. With nobody at a terminal to answer them, say
      // what to run instead of hanging on a prompt that will never be answered.
      if (!interactive) {
        throw new Error([
          'This repo is not set up yet, and there is no terminal to ask you questions in.',
          '  Run `jr-arch` in a terminal, or non-interactively:',
          '  jr-arch init --provider groq --model <model> && jr-arch key <your-key>',
        ].join('\n'));
      }
      const result = await onboard(prompter, { fetchImpl, root });
      if (!result) return;
      models = result.models ?? [];
      gitState = result.git ?? null;
      if (result.mode === 'prompt') {
        const made = await promptMode(prompter, { call: call ?? undefined, fetchImpl, models, root });
        mode = made?.mode ?? 'chat';
      } else {
        mode = result.mode;
      }
    }

    // A returning user has not been asked yet. Only in a real conversation:
    // a prompter reading a closed stdin would answer the default, and the
    // default here is "yes, create a repository".
    if (gitState === null && interactive) gitState = await ensureRepo(prompter, root);
    noGit = gitState === 'no-git';

    banner(mode);

    // --- the conversation ---------------------------------------------------
    for (;;) {
      const line = await prompter.ask(`${c.d(`[${MODES[mode].label}]`)} ${c.b('›')}`);
      if (line === null) break;                       // ctrl-d, or a script ran out
      const input = line.trim();
      if (!input) continue;

      if (input.startsWith('/')) {
        const outcome = await command(input, { mode, prompter, call, fetchImpl, models, root, dir });
        if (outcome === 'exit') break;
        if (outcome?.mode) mode = outcome.mode;
        if (outcome?.models) models = outcome.models;
        continue;
      }

      // @name picks the agent for this one task.
      let agent = null;
      let task = input;
      const at = input.match(/^@([A-Za-z0-9._-]+)\s+([\s\S]+)$/);
      if (at) {
        agent = findAgent(at[1], readAgents(dir));
        if (!agent) {
          warn(`No agent "${at[1]}". Installed: ${readAgents(dir).map((a) => a.name).join(', ') || 'none'}`);
          continue;
        }
        task = at[2];
      }

      if (!readAgents(dir).length) {
        warn('No agents yet. Use /prompt to have them written, or /new <name> to write one.');
        continue;
      }

      let outcome = await turn({ task, agent, call, flags, prompter, build: lastBuild, noGit });

      // The run refused because git cannot undo a failed attempt here. Offer the
      // fix now and then do what was asked, rather than print a flag the person
      // cannot pass from inside a chat.
      if (NEEDS_GIT.has(outcome?.error?.code)) {
        const state = await ensureRepo(prompter, root);
        if (state === 'blocked') continue;
        noGit = state === 'no-git';
        outcome = await turn({ task, agent, call, flags, prompter, build: lastBuild, noGit });
      }
      lastBuild = outcome?.build ?? null;

      // A model that cannot do this at all will not do it next message either.
      // Offering the fix here is the difference between one wasted task and a
      // whole conversation of them.
      if (outcome?.fatal && await prompter.confirm('Pick a different model now?', true)) {
        const swapped = await switchModel({ dir, prompter, fetchImpl, models });
        if (swapped?.models) models = swapped.models;
      }
    }
  } finally {
    prompter.close();
  }
  console.log();
}

/**
 * One task.
 *
 * `--allow-dirty` because across turns the tree holds the agent's own accepted
 * work. NOT `--yes`: a human checkpoint still stops and asks, even here. Chat
 * is a faster way to reach the loop, not a way around its rules.
 */
const NEEDS_GIT = new Set(['NO_GIT_REPO', 'NO_COMMITS']);

async function turn({ task, agent, call, flags, prompter, build, noGit = false }) {
  let outcome = null;
  try {
    outcome = await run([task], {
      ...flags,
      'allow-dirty': true,
      quiet: true,
      ...(noGit ? { 'no-git': true } : {}),
      ...(agent ? { agent: agent.name } : {}),
    }, { ...(call ? { call } : {}), prompter, build });
  } catch (e) {
    // A git refusal is answered by the caller with an offer, so its
    // command-line wording is not printed here.
    if (NEEDS_GIT.has(e.code)) return { error: e };
    warn(e.message);
  }
  console.log();
  // What the run verified on its way out is the state the next turn starts in.
  // Anything else — a failure, a stop — leaves it unknown, and the next turn
  // checks for itself.
  return outcome;
}

/**
 * Switch the default model, and check the new one can actually drive an agent.
 *
 * Used by /models and by the offer made after a task fails on the model itself
 * — without the check, the obvious next move is to pick another model that
 * cannot call tools either.
 */
async function switchModel({ dir, prompter, fetchImpl, models }) {
  const manifest = readManifest(join(dir, 'agent.yaml'));
  let list = models;
  if (!list?.length) {
    try {
      list = await listModels(manifest.provider, process.env[manifest.keyEnv] ?? '', {
        baseUrl: manifest.baseUrl, fetchImpl,
      });
    } catch (e) {
      warn(e.message);
      return null;
    }
  }

  const picked = await pickModel(prompter, { models: list, provider: manifest.provider });
  if (!picked) return null;

  const check = await probeModel({
    provider: manifest.provider,
    model: picked,
    key: process.env[manifest.keyEnv] ?? '',
    baseUrl: manifest.baseUrl,
    fetchImpl,
  });
  if (!(await keepModel(prompter, picked, check))) {
    return switchModel({ dir, prompter, fetchImpl, models: list });
  }

  setModel({ provider: manifest.provider, model: picked, keyEnv: manifest.keyEnv, baseUrl: manifest.baseUrl });
  ok(`Default model is now ${c.c(picked)}`);
  return { models: list, model: picked };
}

async function command(line, ctx) {
  const [cmd, ...args] = line.slice(1).split(/\s+/);
  const arg = args.join(' ').trim();
  const { prompter, dir, root } = ctx;

  switch (cmd) {
    case 'exit': case 'quit': case 'q':
      return 'exit';

    case 'help': case '?':
      console.log(ctx.mode === 'dev' ? `${DEV_HELP}${HELP}` : HELP);
      return null;

    // --- modes --------------------------------------------------------------
    case 'chat':
      info(`${c.b('chat mode')} — type a task and an agent edits the code.`);
      return { mode: 'chat' };

    case 'dev':
      console.log(DEV_HELP);
      return { mode: 'dev' };

    case 'prompt': {
      const made = await promptMode(prompter, { call: ctx.call ?? undefined, fetchImpl: ctx.fetchImpl, models: ctx.models, root });
      return { mode: made?.mode ?? 'chat' };
    }

    // --- setup --------------------------------------------------------------
    case 'key': {
      const conn = await obtainKey(prompter, { fetchImpl: ctx.fetchImpl });
      if (!conn) return null;
      const manifest = readManifest(join(dir, 'agent.yaml'));
      const saved = savedConnections(manifest);

      // A second key for a provider already saved: replace it, or keep both.
      // Writing it over the first without asking silently moves every agent on
      // that key to a different account.
      const existing = saved.find((k) => k.provider === conn.provider);
      if (conn.key && existing && process.env[existing.keyEnv] && process.env[existing.keyEnv] !== conn.key) {
        const label = providerLabel(conn.provider);
        const how = await prompter.choose(`You already have a ${label} key (${existing.keyEnv}).`, [
          { value: 'replace', label: 'Replace it', note: 'everything using it moves to this key' },
          { value: 'add', label: 'Keep both', note: `keys from the same ${label} account share one limit` },
        ]);
        if (how === null) return null;
        conn.keyEnv = how === 'add' ? nextKeyEnv(conn.keyEnv, saved.map((k) => k.keyEnv)) : existing.keyEnv;
      }

      if (conn.key) {
        ensureIgnored(root);
        writeKey(conn.keyEnv, conn.key);
        process.env[conn.keyEnv] = conn.key;
        ok(`Saved as ${c.c(conn.keyEnv)} in .gitagent/.env`);
      }
      addSavedKey({ provider: conn.provider, keyEnv: conn.keyEnv, baseUrl: conn.baseUrl }, join(dir, 'agent.yaml'));
      if (conn.provider !== manifest.provider
        && await prompter.confirm(`Switch your agents to ${conn.provider}?`, true)) {
        const model = await pickModel(prompter, conn);
        if (model) {
          setModel({ provider: conn.provider, model, keyEnv: conn.keyEnv, baseUrl: conn.baseUrl });
          ok(`Agents now use ${c.c(model)} on ${conn.provider}`);
        }
      }
      return { models: conn.models };
    }

    case 'models': case 'model': {
      const manifest = readManifest(join(dir, 'agent.yaml'));
      console.log();
      for (const a of readAgents(dir)) {
        const m = modelFor(manifest, a.name);
        info(`${c.c(a.name.padEnd(16))}${m.model}  ${c.d(`${m.provider} · ${m.keyEnv}`)}`);
      }
      console.log();

      // "Nothing" is the default, so a look at the list is not a change.
      const what = await prompter.choose('Change what?', [
        { value: 'default', label: 'The default model', note: 'every agent without its own' },
        { value: 'agent', label: 'One agent’s model or key', note: 'e.g. a stronger model on another provider' },
        { value: 'none', label: 'Nothing' },
      ], { default: 2 });

      if (what === 'agent') {
        await assignAgent({ dir, root, prompter, fetchImpl: ctx.fetchImpl });
        return null;
      }
      if (what !== 'default') return null;

      let models = ctx.models;
      if (!models?.length) {
        try {
          models = await listModels(manifest.provider, process.env[manifest.keyEnv] ?? '', {
            baseUrl: manifest.baseUrl, fetchImpl: ctx.fetchImpl,
          });
        } catch (e) {
          warn(e.message);
          return null;
        }
      }
      const swapped = await switchModel({ dir, prompter, fetchImpl: ctx.fetchImpl, models });
      return { models: swapped?.models ?? models };
    }

    case 'limits': {
      const { manifest, agents, limits } = await showLimits({ dir, fetchImpl: ctx.fetchImpl });
      if (!agents.length) return null;
      if (!(await prompter.confirm('Change a reply cap?', false))) return null;

      const target = await prompter.choose('Which one?', [
        { value: 'default', label: 'the default', note: 'every agent that has not set its own' },
        ...agents.map((a) => ({ value: a.name, label: a.name, note: a.role })),
      ]);
      if (target === null) return null;

      const suggested = suggestedCap(limits) ?? manifest.maxTokens ?? DEFAULT_CAP;
      const typed = await prompter.ask('Tokens per reply:', { default: String(suggested) });
      const n = Number(typed);
      if (!Number.isInteger(n) || n < 1) { warn(`"${typed}" is not a token count.`); return null; }

      if (target === 'default') {
        setModelMaxTokens(n);
        ok(`Every agent may now generate up to ${c.c(n.toLocaleString())} tokens per reply.`);
      } else {
        setTierMaxTokens(target, n);
        ok(`${c.c(target)} may now generate up to ${c.c(n.toLocaleString())} tokens per reply.`);
      }
      return null;
    }

    case 'agents': {
      const agents = readAgents(dir);
      console.log();
      if (!agents.length) info('No agents yet — /prompt or /new <name>.');
      for (const a of agents) {
        const bits = [a.owns.length ? a.owns.join(' ') : '', a.parallel ? '∥' : '', a.terminal ? 'asks you' : '']
          .filter(Boolean).join(' · ');
        info(`${c.c(a.name.padEnd(16))}${a.role}${bits ? c.d(`  ${bits}`) : ''}`);
      }
      console.log();
      return null;
    }

    case 'tree':
      printTree(dir);
      return null;

    case 'smoke': {
      const names = arg ? [arg] : readAgents(dir).map((a) => a.name);
      if (!names.length) { warn('No agents to test.'); return null; }
      for (const name of names) {
        printSmoke(await smokeTest(name, { dir, call: ctx.call ?? undefined, fetchImpl: ctx.fetchImpl }));
      }
      return null;
    }

    // --- dev ----------------------------------------------------------------
    case 'new': {
      if (!arg) { warn('Usage: /new <agent-name>'); return null; }
      try {
        const made = newAgent(arg, { dir });
        ok(`Created ${c.c(arg)}`);
        for (const f of made.files) info(`  ${f}`);
        info(c.d(`Edit those, then /check and /smoke ${arg}.`));
      } catch (e) { warn(e.message); }
      return null;
    }

    case 'guard': {
      if (!arg) { warn('Usage: /guard <name>'); return null; }
      try {
        const made = newGuard(arg, { dir });
        ok(`Created guard ${c.c(arg)}`);
        info(`  ${made.file}`);
        info(c.d('Fill in the paths or commands, then /check.'));
      } catch (e) { warn(e.message); }
      return null;
    }

    case 'edit': {
      if (!arg) { warn('Usage: /edit <agent-name>'); return null; }
      const files = pathsFor(arg, { dir });
      if (!files) { warn(`No agent "${arg}".`); return null; }
      console.log();
      for (const f of files) info(f);
      console.log();
      return null;
    }

    case 'check':
      printCheck(checkAll({ dir }));
      return null;

    // --- repo ---------------------------------------------------------------
    case 'status': {
      const build = verify({ root });
      const dirty = isRepo(root) ? dirtyFiles(root) : [];
      const branch = isRepo(root) ? git(['rev-parse', '--abbrev-ref', 'HEAD'], { root, check: false }) : null;
      console.log();
      if (branch) info(`branch     ${c.c(branch)}`);
      info(`build      ${build.green === true ? c.g('green') : build.green === false ? c.r('red') : c.y('unknown')}${build.label ? c.d(`  ${build.label}`) : ''}`);
      info(`changed    ${dirty.length ? dirty.slice(0, 8).join(', ') : c.d('nothing')}`);
      console.log();
      return null;
    }

    // Undo is the one command here that destroys work, so it checks three
    // things first: that the commit is ours, that nothing uncommitted would go
    // with it, and that the user means it. It used to check none of them, and
    // `git reset --hard HEAD~1` on someone else's commit with a dirty tree
    // takes both.
    case 'undo': {
      if (!isRepo(root)) { warn('Not a git repo — nothing to undo.'); return null; }

      const body = git(['log', '-1', '--pretty=%B'], { root, check: false });
      const subject = git(['log', '-1', '--pretty=%s'], { root, check: false });
      if (!body) { warn('No commits to undo.'); return null; }

      if (!body.includes('via jr-arch')) {
        warn(`The last commit is not one of ours: "${subject}"`);
        info(c.d('/undo only rolls back commits an agent made. Use git for your own.'));
        return null;
      }

      const dirty = dirtyFiles(root);
      if (dirty.length) {
        warn(`${dirty.length} uncommitted change(s) would be destroyed with it.`);
        info(c.d(`  ${dirty.slice(0, 5).join(', ')}`));
        info(c.d('Commit or stash them first.'));
        return null;
      }

      if (!(await prompter.confirm(`Roll back "${subject}"?`, false))) return null;
      git(['reset', '--hard', 'HEAD~1'], { root, check: false });
      ok('Rolled back.');
      return null;
    }

    default:
      warn(`Unknown command /${cmd}. Try /help.`);
      return null;
  }
}

const providerLabel = (id) => providerFor(id)?.label ?? id;

/**
 * Put one agent on a provider, model and key the person chooses.
 *
 * Saved keys are offered first, so a key added once is never pasted again. A
 * new key is last — the one option always present — so the saved ones above
 * it keep their numbers from one run to the next. The chosen model gets the
 * same check setup gives: can it call a tool, and what does its key allow per
 * minute, which is recorded on the agent so it is fitted against its own
 * provider rather than the default's.
 */
async function assignAgent({ dir, root, prompter, fetchImpl }) {
  const manifest = readManifest(join(dir, 'agent.yaml'));
  const agents = readAgents(dir);
  if (!agents.length) { warn('No agents yet.'); return; }

  const name = await prompter.choose('Which agent?', agents.map((a) => {
    const m = modelFor(manifest, a.name);
    return { value: a.name, label: a.name, note: `${m.model} on ${providerLabel(m.provider)}` };
  }));
  if (!name) return;

  const saved = savedConnections(manifest);
  const pick = await prompter.choose(`Which key should ${name} use?`, [
    ...saved.map((k) => ({
      value: k.keyEnv,
      label: providerLabel(k.provider),
      note: [k.keyEnv, k.isDefault ? 'the default' : '', requiresKey(k) && !process.env[k.keyEnv] ? 'not set' : '']
        .filter(Boolean).join(' · '),
    })),
    { value: '__new', label: 'A new key', note: 'paste one now' },
  ]);
  if (!pick) return;

  let conn;
  if (pick === '__new') {
    conn = await obtainKey(prompter, { fetchImpl });
    if (!conn) return;
    const same = saved.find((k) => conn.key && process.env[k.keyEnv] === conn.key);
    conn.keyEnv = same ? same.keyEnv : nextKeyEnv(conn.keyEnv, saved.map((k) => k.keyEnv));
    if (conn.key && !same) {
      ensureIgnored(root);
      writeKey(conn.keyEnv, conn.key);
      process.env[conn.keyEnv] = conn.key;
    }
    addSavedKey({ provider: conn.provider, keyEnv: conn.keyEnv, baseUrl: conn.baseUrl }, join(dir, 'agent.yaml'));
  } else {
    conn = { ...saved.find((k) => k.keyEnv === pick) };
    if (requiresKey(conn) && !process.env[conn.keyEnv]) {
      warn(`${conn.keyEnv} is not set. Add it with /key first.`);
      return;
    }
    try {
      conn.models = await listModels(conn.provider, process.env[conn.keyEnv] ?? '', { baseUrl: conn.baseUrl, fetchImpl });
    } catch (e) {
      warn(e.message);
      conn.models = [];
    }
  }

  const model = await pickModel(prompter, { models: conn.models, provider: conn.provider });
  if (!model) return;

  const check = await probeModel({
    provider: conn.provider, model, key: process.env[conn.keyEnv] ?? '', baseUrl: conn.baseUrl, fetchImpl,
  });
  if (!(await keepModel(prompter, model, check))) return;
  const perMinute = check.limits?.rows?.find((r) => r.key === 'tokens')?.limit
    ?? check.limits?.rows?.find((r) => r.key === 'input')?.limit
    ?? null;

  setTierConnection(name, {
    provider: conn.provider, model, keyEnv: conn.keyEnv, baseUrl: conn.baseUrl, tokensPerMinute: perMinute,
  }, join(dir, 'agent.yaml'));
  ok(`${c.c(name)} now runs ${c.c(model)} on ${providerLabel(conn.provider)}`);
  if (perMinute) info(c.d(`  its key allows ${perMinute.toLocaleString()} tokens a minute, on its own account`));
}

/** Key variables a run would actually need and cannot find. */
function missingKeys(dir) {
  const manifest = readManifest(join(dir, 'agent.yaml'));
  const names = new Set();
  for (const tier of [null, ...readAgents(dir).map((a) => a.name)]) {
    const m = tier ? modelFor(manifest, tier) : manifest;
    if (requiresKey(m) && m.keyEnv && !process.env[m.keyEnv]) names.add(m.keyEnv);
  }
  return [...names];
}

function banner(mode) {
  const dir = agentDir();
  const manifest = readManifest(join(dir, 'agent.yaml'));
  const agents = readAgents(dir);
  console.log();
  console.log(`  ${c.b('jr-arch')} ${c.d(`· ${agents.length} agent${agents.length === 1 ? '' : 's'} · ${manifest.model} on ${manifest.provider}`)}`);
  console.log(`  ${c.d(MODES[mode].hint)}`);
  console.log();
}
