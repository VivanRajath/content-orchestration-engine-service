import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readAgents } from './agents.js';
import { hookFiles } from './hooks.js';
import { c } from './util.js';

/**
 * `.gitagent/` drawn as a tree, with what each thing is for.
 *
 * Shown after setup and on `/tree`, because "where do I edit this?" is the
 * first question anyone has after scaffolding something, and a path they can
 * copy answers it better than any explanation. The absolute path is printed
 * first so it can be pasted straight into an editor.
 */

const NOTES = {
  'agent.yaml': 'model, provider, routing',
  'DUTIES.md': 'how agents hand work to each other',
  '.env': 'your API key — gitignored, never committed',
  '.pack.lock': 'what a pack installed, for pull',
  'hooks': 'guardrails the harness enforces',
  'agents': 'one folder per agent',
  'config': 'environment settings',
  'memory': 'notes you keep about this repo',
  'SOUL.md': 'who this agent is',
  'RULES.md': 'what it must and must not do',
};

/** Hidden or noisy: the transcript directory and the pack's own provenance. */
const SKIP = new Set(['.session', '.source']);

export function renderTree(dir, { maxDepth = 3 } = {}) {
  if (!existsSync(dir)) return [];

  const agents = new Map(readAgents(dir).map((a) => [a.name, a]));
  const guards = new Set(hookFiles(dir).map((f) => f.split(/[\\/]/).pop()));
  const lines = [];

  const walk = (path, prefix, depth) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true }).filter((e) => !SKIP.has(e.name));
    } catch {
      return;
    }
    // Directories first, then files, each alphabetical — the order people scan.
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));

    entries.forEach((e, i) => {
      const last = i === entries.length - 1;
      const branch = last ? '└── ' : '├── ';
      const rel = relative(dir, join(path, e.name)).split(/[\\/]/);
      const note = noteFor(e.name, rel, agents, guards);
      const name = e.isDirectory() ? c.c(`${e.name}/`) : e.name;
      lines.push(`${prefix}${branch}${name}${note ? `  ${c.d(note)}` : ''}`);
      if (e.isDirectory() && depth < maxDepth) {
        walk(join(path, e.name), prefix + (last ? '    ' : '│   '), depth + 1);
      }
    });
  };

  walk(dir, '', 1);
  return lines;
}

function noteFor(name, rel, agents, guards) {
  // An agent folder is annotated with what the agent says it does.
  if (rel.length === 2 && rel[0] === 'agents' && agents.has(name)) {
    const a = agents.get(name);
    const bits = [a.role, a.owns.length ? `owns ${a.owns.join(' ')}` : '', a.parallel ? 'parallel' : '']
      .filter(Boolean);
    return bits.join(' · ');
  }
  if (rel.length === 2 && rel[0] === 'hooks' && guards.has(name)) {
    return name === 'hooks.yaml' ? 'your guardrails' : 'added guard';
  }
  return NOTES[name] ?? '';
}

export function printTree(dir) {
  console.log();
  console.log(`  ${c.b(dir)}`);
  for (const line of renderTree(dir)) console.log(`  ${line}`);
  console.log();
}

/** Every file under a directory, for listing what a generation step wrote. */
export function filesUnder(dir) {
  const out = [];
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (statSync(full).isFile()) out.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}
