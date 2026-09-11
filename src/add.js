import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { agentDir } from './paths.js';
import { fetchPack, confine } from './pack.js';
import { frontMatter, readAgents } from './agents.js';
import { parseYaml } from './yaml.js';
import { loadHooks } from './hooks.js';
import { c, ok, info, warn } from './util.js';

/**
 * `add-agent <url>` and `add-guard <url>`.
 *
 * Two commands with one shape: point at a git repo, get a thing installed. An
 * agent is a folder with a SOUL.md; a guard is a YAML file of hooks. Neither
 * requires a manifest, a registry entry, or a second command afterwards —
 * installing is copying the files in, and the loop reads the directory.
 *
 * Both pull code that will run against the user's repo, so both print what is
 * arriving BEFORE it lands. An agent's RULES.md is prompt text a stranger
 * wrote; a guard file is the thing deciding what that prompt is allowed to do.
 */

// ---------------------------------------------------------------------------
// add-agent
// ---------------------------------------------------------------------------

export async function addAgent(positional, flags) {
  const url = positional?.[0] ?? flags.from;
  if (!url) {
    throw new Error('Usage: jr-arch add-agent <git-url> [--as <name>] [--ref <branch|sha>]');
  }

  const dest = join(agentDir(), 'agents');
  if (!existsSync(join(agentDir(), 'agent.yaml'))) {
    throw new Error('No .gitagent/ found. Run `jr-arch init` first.');
  }
  mkdirSync(dest, { recursive: true });

  const fetched = fetchPack(url, { ref: typeof flags.ref === 'string' ? flags.ref : null });
  try {
    const found = findAgents(fetched.dir);
    if (!found.length) {
      throw new Error([
        `No agent found in ${url}.`,
        '  An agent is a folder containing SOUL.md — at the repo root, or under agents/.',
      ].join('\n'));
    }

    // --as renames, which only makes sense for a repo holding exactly one.
    if (flags.as && found.length > 1) {
      throw new Error(`That repo has ${found.length} agents; --as only works when there is one.`);
    }

    console.log();
    for (const a of found) {
      const name = flags.as && found.length === 1 ? String(flags.as) : a.name;
      info(`${c.c(name.padEnd(16))}${a.role || c.d('(no role declared)')}`);
      if (!a.hasRules) warn(`  ${name} ships no RULES.md — it has identity but no stated constraints`);
    }
    if (fetched.sha) info(c.d(`commit ${fetched.sha.slice(0, 7)}`));
    console.log();
    warn('A pulled agent is untrusted input — read its RULES.md before running it.');
    console.log();

    const installed = [];
    for (const a of found) {
      const name = flags.as && found.length === 1 ? String(flags.as) : a.name;
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
        warn(`skipped "${name}" — not a usable folder name`);
        continue;
      }
      const target = join(dest, name);
      if (existsSync(target) && !flags.force) {
        warn(`skipped ${name} — already installed (use --force to replace)`);
        continue;
      }
      rmSync(target, { recursive: true, force: true });
      cpSync(a.dir, target, { recursive: true, dereference: true });
      stampSource(target, url, fetched.sha);
      installed.push(name);
    }

    if (!installed.length) throw new Error('Nothing was installed.');
    ok(`Added ${installed.map((n) => c.c(n)).join(', ')}`);

    const all = readAgents();
    info(`${all.length} agent(s) installed: ${all.map((a) => a.name).join(', ')}`);
    console.log();
  } finally {
    fetched.cleanup();
  }
}

/** Every folder in the clone that looks like an agent. */
function findAgents(root) {
  const out = [];
  const consider = (dir, name) => {
    const soul = join(dir, 'SOUL.md');
    if (!existsSync(soul)) return;
    const { meta } = frontMatter(readFileSync(soul, 'utf8'));
    out.push({
      dir,
      name: String(meta.name || name).trim(),
      role: typeof meta.role === 'string' ? meta.role.trim() : '',
      hasRules: existsSync(join(dir, 'RULES.md')),
    });
  };

  // A repo can BE one agent, or CONTAIN a folder of them — both are normal.
  // A repo that contains agents/ is not also an agent itself, even when it has
  // a SOUL.md at the root: that file is the pack's own description, and
  // counting it installs a fifth agent nobody asked for.
  for (const sub of ['agents', 'personas']) {
    const base = join(root, sub);
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (e.isDirectory()) consider(join(base, e.name), e.name);
    }
  }
  if (!out.length) consider(root, basename(root));
  return out;
}

/**
 * Record where an agent came from, in the agent's own folder.
 *
 * Not in agent.yaml: the agent is the unit that was installed, so the unit is
 * where its provenance belongs. Deleting the folder removes the agent and its
 * source record together, with nothing left behind to go stale.
 */
function stampSource(dir, url, sha) {
  writeFileSync(join(dir, '.source'), `${url}\n${sha ?? ''}\n`);
}

// ---------------------------------------------------------------------------
// add-guard
// ---------------------------------------------------------------------------

/**
 * Install a guardrail file into `hooks/`.
 *
 * Guards are additive. `loadHooks` reads every YAML file in the directory, so
 * a pulled guard sits beside the repo's own rather than replacing it, and the
 * sealed hooks in hooks.js still cannot be relaxed by any of them.
 */
export async function addGuard(positional, flags) {
  const url = positional?.[0] ?? flags.from;
  if (!url) throw new Error('Usage: jr-arch add-guard <git-url> [--as <name>] [--ref <branch|sha>]');

  const dir = agentDir();
  if (!existsSync(join(dir, 'agent.yaml'))) {
    throw new Error('No .gitagent/ found. Run `jr-arch init` first.');
  }
  const dest = join(dir, 'hooks');
  mkdirSync(dest, { recursive: true });

  const fetched = fetchPack(url, { ref: typeof flags.ref === 'string' ? flags.ref : null });
  try {
    const files = findGuards(fetched.dir);
    if (!files.length) {
      throw new Error(`No guardrail file found in ${url}. A guard is a .yaml file declaring hook phases.`);
    }

    console.log();
    let phases = 0;
    for (const rel of files) {
      const doc = parseYaml(readFileSync(join(fetched.dir, rel), 'utf8'), rel) ?? {};
      const named = Object.entries(doc)
        .filter(([, v]) => Array.isArray(v))
        .map(([phase, hooks]) => {
          phases += hooks.length;
          return `${phase}: ${hooks.map((h) => h?.name).filter(Boolean).join(', ')}`;
        });
      info(`${c.c(rel)}`);
      for (const line of named) info(`  ${line}`);
    }
    if (!phases) warn('That file declares no hooks — nothing would be enforced.');
    console.log();
    // A pulled guard can only ever tighten: hooks.js seals the ones that matter
    // in code, so this file cannot disable them however it is written.
    info('Guards are additive, and can only tighten — sealed hooks stay sealed.');
    console.log();

    const installed = [];
    for (const rel of files) {
      const name = flags.as && files.length === 1 ? withYaml(String(flags.as)) : basename(rel);
      if (name === 'hooks.yaml' && !flags.force) {
        warn('skipped hooks.yaml — that is your own guard file (use --as <name>, or --force)');
        continue;
      }
      const target = join(dest, name);
      if (existsSync(target) && !flags.force) {
        warn(`skipped ${name} — already present (use --force to replace)`);
        continue;
      }
      cpSync(join(fetched.dir, confine(fetched.dir, rel, 'guard')), target, { dereference: true });
      installed.push(name);
    }
    if (!installed.length) throw new Error('Nothing was installed.');

    // Load them for real, so a guard that does not parse fails here rather
    // than aborting the user's next run.
    const set = loadHooks(dir, { reload: true });
    for (const note of set.notes) warn(note);

    ok(`Added ${installed.map((n) => c.c(n)).join(', ')} to .gitagent/hooks/`);
    console.log();
  } finally {
    fetched.cleanup();
  }
}

const withYaml = (n) => (/\.ya?ml$/i.test(n) ? n : `${n}.yaml`);

function findGuards(root) {
  const out = [];
  const scan = (rel) => {
    const base = rel ? join(root, rel) : root;
    if (!existsSync(base)) return;
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isFile() || !/\.ya?ml$/i.test(e.name)) continue;
      if (e.name === 'gitagent.yaml' || e.name === 'agent.yaml') continue;
      out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  scan('hooks');
  scan('guards');
  if (!out.length) scan('');
  return out;
}
