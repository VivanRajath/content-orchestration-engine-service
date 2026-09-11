import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { agentDir, repoRoot } from './paths.js';
import { readManifest, modelFor, keyEnvs } from './config.js';
import { readAgents } from './agents.js';
import { dirtyFiles, isRepo, git } from './session.js';
import { verify } from './verify.js';
import { run } from './run.js';
import { c, ok, info, warn } from './util.js';

/**
 * `jr-arch` with no arguments: a chat that edits the repo.
 *
 * Each message is a task, and a task is a run — the same ladder, the same
 * guardrails, the same session branch. This is a front door onto the loop, not
 * a second execution path, because a second path is a second place for the
 * hooks to be missing.
 *
 * The one thing chat changes is the dirty-tree rule. A run refuses to start on
 * uncommitted work because failed attempts roll back with `git reset --hard`;
 * across several chat turns the agent's own accepted output IS uncommitted
 * work, so chat commits each accepted turn to the session branch and the next
 * turn starts clean.
 */

const HELP = `
  ${c.b('Type a task.')} It edits files in this repo.

  ${c.c('@agent <task>')}   send it to a specific agent
  ${c.c('/agents')}         list installed agents
  ${c.c('/model')}          show models and keys
  ${c.c('/status')}         branch, build state, uncommitted files
  ${c.c('/undo')}           roll the last turn back
  ${c.c('/help')}           this
  ${c.c('/exit')}           leave
`;

export async function chat(positional, flags, { call } = {}) {
  const root = repoRoot();
  const dir = agentDir();

  if (!existsSync(join(dir, 'agent.yaml'))) {
    throw new Error([
      'No .gitagent/ in this repo.',
      '  jr-arch init                       scaffold the defaults',
      '  jr-arch init --from <git-url>      install an agent pack',
    ].join('\n'));
  }

  const manifest = readManifest();
  const agents = readAgents(dir);
  if (!agents.length) {
    throw new Error('No agents installed.\n  jr-arch add-agent <git-url>');
  }

  // Fail at the door, not three messages in. A missing key is the single most
  // common reason a first session goes nowhere.
  const missing = keyEnvs(manifest).filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error([
      `No API key for ${missing.join(', ')}.`,
      '  jr-arch key <your-key>',
      missing.length > 1 ? '  jr-arch key --env <NAME> <your-key>' : '',
    ].filter(Boolean).join('\n'));
  }

  banner(manifest, agents, root);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let lastAgent = null;

  try {
    for (;;) {
      let line;
      try {
        line = (await rl.question(c.b('› '))).trim();
      } catch {
        break;                                  // ctrl-d
      }
      if (!line) continue;

      if (line.startsWith('/')) {
        const done = await command(line, { manifest, agents, root, dir, rl });
        if (done) break;
        continue;
      }

      // @agent picks the agent for this turn and is remembered for the next.
      let agent = null;
      let task = line;
      const at = line.match(/^@([A-Za-z0-9._-]+)\s+([\s\S]+)$/);
      if (at) {
        agent = agents.find((a) => a.name === at[1]);
        if (!agent) {
          warn(`No agent "${at[1]}". Installed: ${agents.map((a) => a.name).join(', ')}`);
          continue;
        }
        task = at[2];
        lastAgent = agent.name;
      }

      await turn({ task, agent, root, call, flags });
    }
  } finally {
    rl.close();
  }
  console.log();
}

/**
 * One chat message.
 *
 * `--allow-dirty` is passed because the tree legitimately holds the previous
 * turn's work; `--yes` is not, so a human checkpoint still stops and asks even
 * here. Chat is a faster way to reach the loop, not a way around its rules.
 */
async function turn({ task, agent, root, call, flags }) {
  try {
    await run([task], {
      ...flags,
      'allow-dirty': true,
      quiet: true,
      ...(agent ? { agent: agent.name } : {}),
    }, call ? { call } : undefined);
  } catch (e) {
    warn(e.message);
  }
  console.log();
}

async function command(line, { manifest, agents, root, dir, rl }) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);

  switch (cmd) {
    case 'exit':
    case 'quit':
    case 'q':
      return true;

    case 'help':
    case '?':
      console.log(HELP);
      return false;

    case 'agents': {
      console.log();
      for (const a of agents) {
        const scope = a.owns.length ? c.d(`  ${a.owns.join(', ')}`) : '';
        const par = a.parallel ? c.d('  ∥') : '';
        info(`${c.c(a.name.padEnd(16))}${a.role}${scope}${par}`);
      }
      console.log();
      return false;
    }

    case 'model': {
      console.log();
      for (const a of agents) {
        const m = modelFor(manifest, a.name);
        const set = process.env[m.keyEnv] ? c.g('key set') : c.y('no key');
        info(`${c.c(a.name.padEnd(16))}${String(m.model).padEnd(26)}${c.d(`${m.provider}  ${set}`)}`);
      }
      console.log();
      info(c.d('change one:  jr-arch config set model.name <model>'));
      console.log();
      return false;
    }

    case 'status': {
      const build = verify({ root });
      const dirty = isRepo(root) ? dirtyFiles(root) : [];
      const branch = isRepo(root) ? git(['rev-parse', '--abbrev-ref', 'HEAD'], { root, check: false }) : null;
      console.log();
      if (branch) info(`branch     ${c.c(branch)}`);
      info(`build      ${build.green === true ? c.g('green') : build.green === false ? c.r('red') : c.y('unknown')}${build.label ? c.d(`  ${build.label}`) : ''}`);
      info(`changed    ${dirty.length ? dirty.slice(0, 8).join(', ') : c.d('nothing')}`);
      console.log();
      return false;
    }

    case 'undo': {
      if (!isRepo(root)) { warn('Not a git repo — nothing to undo.'); return false; }
      const last = git(['log', '-1', '--pretty=%s'], { root, check: false });
      if (!last) { warn('No commits to undo.'); return false; }
      const answer = (await rl.question(`  Roll back ${c.c(last)}? [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') return false;
      // --hard, because the point is to discard the turn, and the tree at this
      // moment holds only agent output — the entry check refused to start on
      // anything of the user's.
      git(['reset', '--hard', 'HEAD~1'], { root, check: false });
      ok('Rolled back.');
      return false;
    }

    default:
      warn(`Unknown command /${cmd}. Try /help.`);
      return false;
  }
}

function banner(manifest, agents, root) {
  console.log();
  console.log(`  ${c.b('jr-arch')} ${c.d(`· ${agents.length} agent(s) · ${manifest.model}`)}`);
  console.log(`  ${c.d(root)}`);
  console.log(HELP);
}
