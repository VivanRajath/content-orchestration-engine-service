import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { agentDir } from './paths.js';
import { readAgents, findAgent, frontMatter, escalationCycle } from './agents.js';
import { loadHooks, hookFiles } from './hooks.js';
import { c, ok, info, warn } from './util.js';

/**
 * /dev — write agents and guardrails by hand.
 *
 * Nothing here calls a model. It scaffolds files with every field the loop
 * reads already present and commented, prints where they are so they can be
 * opened, and checks them afterwards — because a hand-written agent with a
 * typo in `escalates_to` fails silently at run time, and it is much cheaper to
 * be told now.
 */

const NAME = /^[a-z][a-z0-9-]{1,31}$/;

export function agentTemplate(name) {
  return `---
name: ${name}
role: TODO — one line on what this agent is responsible for
priority: 50              # lower numbers claim work first
parallel: false           # true only if \`owns\` is set and overlaps no other agent
owns: []                  # globs this agent claims, e.g. ["src/api/**"]; [] means anything
# escalates_to: other-agent   who takes over when this one runs out of attempts
# terminal: true              instead: stop and ask you
# fixes_build: true           a red build comes here first (one agent at most)
attempts: 2
---

# ${name}

Who this agent is, and why it exists separately from the others.

## How you work

Read the surrounding code before changing it. Match what is already there.

## Boundary

When the task stops being yours, hand it off instead of reaching past the
boundary. Say who to, and why.
`;
}

export function rulesTemplate(name) {
  return `# Rules — ${name}

## Must

- Verify the change with the project's own test or build command.

## Must not

- Add, remove, or upgrade a dependency without approval.

## Hand off when

- The task needs a decision these rules do not answer.
`;
}

export function guardTemplate(name) {
  return `# Guard: ${name}
#
# Guards are enforced by the harness, whatever an agent believes. A hook is
# checked by what it declares, so name it anything:
#
#   paths:     files it applies to (globs)
#   commands:  programs it applies to
#   severity:  block (default) · warn · checkpoint (stop and ask you)
#   applies_to: [agent-name]   optional — only for these agents
#
# The sealed hooks (secret-scan, no-force-push, protected-read, no-sudo) cannot
# be loosened from here, only added to.

pre_edit:
  - name: ${name}-paths
    description: Files no agent may change.
    severity: block
    paths:
      - "TODO/**"

pre_command:
  - name: ${name}-commands
    description: Commands that must wait for your approval.
    severity: checkpoint
    commands: []
`;
}

export function newAgent(name, { dir = agentDir(), force = false } = {}) {
  if (!NAME.test(name)) {
    throw new Error(`"${name}" is not a usable agent name — lowercase letters, digits and dashes, 2–32 long.`);
  }
  const target = join(dir, 'agents', name);
  if (existsSync(target) && !force) throw new Error(`Agent "${name}" already exists at ${target}`);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'SOUL.md'), agentTemplate(name));
  writeFileSync(join(target, 'RULES.md'), rulesTemplate(name));
  return { dir: resolve(target), files: [resolve(target, 'SOUL.md'), resolve(target, 'RULES.md')] };
}

export function newGuard(name, { dir = agentDir(), force = false } = {}) {
  if (!NAME.test(name)) {
    throw new Error(`"${name}" is not a usable guard name — lowercase letters, digits and dashes.`);
  }
  if (name === 'hooks') throw new Error('"hooks" is your main guard file — pick another name.');
  const file = join(dir, 'hooks', `${name}.yaml`);
  if (existsSync(file) && !force) throw new Error(`Guard "${name}" already exists at ${file}`);
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(file, guardTemplate(name));
  return { file: resolve(file) };
}

/**
 * Everything that would make a run go wrong, found before the run.
 *
 * Errors are things the loop cannot work around. Warnings are things it will
 * survive but probably not the way the author meant.
 */
export function checkAll({ dir = agentDir() } = {}) {
  const errors = [];
  const warnings = [];
  const agents = readAgents(dir);

  if (!agents.length) errors.push('no agents installed');

  for (const a of agents) {
    const raw = readFileSync(join(a.dir, 'SOUL.md'), 'utf8');
    const { meta, body } = frontMatter(raw);
    if (/^---/.test(raw) && !Object.keys(meta).length) {
      errors.push(`${a.name}: SOUL.md front matter does not parse — check for tabs or a missing space after a colon`);
    }
    if (!body.trim()) errors.push(`${a.name}: SOUL.md has no body, so the model would be told nothing`);
    if (/TODO/.test(raw)) warnings.push(`${a.name}: SOUL.md still has TODO placeholders`);
    if (!a.hasRules) warnings.push(`${a.name}: no RULES.md`);
    if (a.escalatesTo && !findAgent(a.escalatesTo, agents)) {
      errors.push(`${a.name}: escalates_to "${a.escalatesTo}" is not installed`);
    }
    if (a.terminal && a.escalatesTo) warnings.push(`${a.name}: terminal and escalates_to both set — terminal wins`);
    if (a.parallel && !a.owns.length) {
      warnings.push(`${a.name}: parallel with no owns — it overlaps with everyone, so it will run alone anyway`);
    }
    if (meta.model || meta.provider || meta.api_key_env) {
      warnings.push(`${a.name}: model/provider in SOUL.md is ignored — set it in agent.yaml under tiers:`);
    }
  }

  const fixers = agents.filter((a) => a.fixesBuild);
  if (fixers.length > 1) {
    warnings.push(`fixes_build on ${fixers.map((a) => a.name).join(', ')} — a red build goes to ${fixers[0].name} only`);
  }

  const cycle = agents.length ? escalationCycle(agents) : null;
  if (cycle) {
    errors.push(`escalation loop: ${cycle.join(' → ')} → ${cycle[0]} — nothing in it ever reaches you. Make one terminal.`);
  }

  if (agents.length && !agents.some((a) => a.terminal)) {
    info(c.d('  (no agent is terminal — the last by priority stops and asks you, which is usually right)'));
  }

  let guardCount = 0;
  try {
    const hooks = loadHooks(dir, { reload: true });
    const files = hookFiles(dir);
    guardCount = files.length;
    for (const n of hooks.notes) warnings.push(n);
    // Declared, loaded, and never executed. Saying so here is the same rule as
    // everywhere else: a guard that quietly does nothing is worse than none.
    const postRun = Object.keys(hooks.post_run ?? {});
    if (postRun.length) {
      warnings.push(`post_run hooks are not executed yet (${postRun.join(', ')}) — they protect nothing`);
    }
    // A scaffolded guard still pointing at TODO/** protects nothing, and does
    // it silently — the file loads, so nothing else would ever flag it.
    for (const f of files) {
      if (/TODO/.test(readFileSync(f, 'utf8'))) {
        warnings.push(`hooks/${basename(f)}: still has TODO placeholders — it protects nothing yet`);
      }
    }
  } catch (e) {
    errors.push(`guards: ${e.message}`);
  }

  return { agents: agents.length, guards: guardCount, errors, warnings };
}

export function printCheck(result) {
  console.log();
  info(`${result.agents} agent${result.agents === 1 ? '' : 's'} · ${result.guards} guard file${result.guards === 1 ? '' : 's'}`);
  for (const e of result.errors) console.log(`  ${c.r('✗')} ${e}`);
  for (const w of result.warnings) console.log(`  ${c.y('!')} ${w}`);
  console.log();
  if (!result.errors.length) ok(result.warnings.length ? 'No errors.' : 'Everything checks out.');
  else warn(`${result.errors.length} problem${result.errors.length === 1 ? '' : 's'} to fix before running.`);
  console.log();
}

/** Where to find an agent's files, as absolute paths that can be opened. */
export function pathsFor(name, { dir = agentDir() } = {}) {
  const a = findAgent(name, readAgents(dir));
  if (!a) return null;
  return readdirSync(a.dir).filter((f) => !f.startsWith('.')).map((f) => resolve(a.dir, f));
}

export const DEV_HELP = `
  ${c.b('/dev')} ${c.d('— write your own agents and guardrails')}

  ${c.c('/new <name>')}      scaffold an agent: SOUL.md + RULES.md
  ${c.c('/guard <name>')}    scaffold a guard file in hooks/
  ${c.c('/edit <name>')}     show where an agent's files are
  ${c.c('/check')}           find problems before a run does
  ${c.c('/smoke <name>')}    test that an agent actually works
  ${c.c('/tree')}            show the whole .gitagent/ folder
  ${c.c('@name <task>')}     give a task to one agent
`;
