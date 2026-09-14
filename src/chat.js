import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir, repoRoot } from './paths.js';
import { readManifest, modelFor, keyEnvs } from './config.js';
import { readAgents, findAgent } from './agents.js';
import { dirtyFiles, isRepo, git } from './session.js';
import { verify } from './verify.js';
import { run } from './run.js';
import { createPrompter } from './prompter.js';
import { onboard, obtainKey, pickModel, setModel } from './onboard.js';
import { promptMode } from './generate.js';
import { newAgent, newGuard, checkAll, printCheck, pathsFor, DEV_HELP } from './dev.js';
import { smokeTest, printSmoke } from './smoke.js';
import { printTree } from './tree.js';
import { writeKey, ensureIgnored } from './env.js';
import { listModels } from './providers.js';
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
  ${c.c('/key')}             add or change an API key
  ${c.c('/models')}          switch model
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

    const needsSetup = !existsSync(join(dir, 'agent.yaml'))
      || keyEnvs(readManifest(join(dir, 'agent.yaml'))).some((n) => !process.env[n] && n !== 'OLLAMA_API_KEY');

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
      if (result.mode === 'prompt') {
        await promptMode(prompter, { call: call ?? undefined, fetchImpl, models, root });
        mode = 'chat';
      } else {
        mode = result.mode;
      }
    }

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

      await turn({ task, agent, call, flags, prompter });
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
async function turn({ task, agent, call, flags, prompter }) {
  try {
    await run([task], {
      ...flags,
      'allow-dirty': true,
      quiet: true,
      ...(agent ? { agent: agent.name } : {}),
    }, { ...(call ? { call } : {}), prompter });
  } catch (e) {
    warn(e.message);
  }
  console.log();
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

    case 'prompt':
      await promptMode(prompter, { call: ctx.call ?? undefined, fetchImpl: ctx.fetchImpl, models: ctx.models, root });
      return { mode: 'chat' };

    // --- setup --------------------------------------------------------------
    case 'key': {
      const conn = await obtainKey(prompter, { fetchImpl: ctx.fetchImpl });
      if (!conn) return null;
      const manifest = readManifest(join(dir, 'agent.yaml'));
      if (conn.key) {
        ensureIgnored(root);
        writeKey(conn.keyEnv, conn.key);
        process.env[conn.keyEnv] = conn.key;
        ok(`Saved as ${c.c(conn.keyEnv)} in .gitagent/.env`);
      }
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
      console.log();
      for (const a of readAgents(dir)) {
        const m = modelFor(manifest, a.name);
        info(`${c.c(a.name.padEnd(16))}${m.model}  ${c.d(m.provider)}`);
      }
      console.log();
      if (!(await prompter.confirm('Switch the default model?', false))) return { models };
      const picked = await pickModel(prompter, { models, provider: manifest.provider });
      if (picked) {
        setModel({ provider: manifest.provider, model: picked, keyEnv: manifest.keyEnv, baseUrl: manifest.baseUrl });
        ok(`Default model is now ${c.c(picked)}`);
      }
      return { models };
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

    case 'undo': {
      if (!isRepo(root)) { warn('Not a git repo — nothing to undo.'); return null; }
      const last = git(['log', '-1', '--pretty=%s'], { root, check: false });
      if (!last) { warn('No commits to undo.'); return null; }
      if (!(await prompter.confirm(`Roll back "${last}"?`, false))) return null;
      git(['reset', '--hard', 'HEAD~1'], { root, check: false });
      ok('Rolled back.');
      return null;
    }

    default:
      warn(`Unknown command /${cmd}. Try /help.`);
      return null;
  }
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
