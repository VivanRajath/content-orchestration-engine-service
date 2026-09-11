import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './paths.js';
import { fetchPack, confine } from './pack.js';
import { readAgents } from './agents.js';
import { readManifest, patchSequence } from './config.js';
import { c, ok, info, warn } from './util.js';

function tiersDir() {
  const d = join(agentDir(), 'agents');
  if (!existsSync(d)) throw new Error('No .gitagent/agents/ found. Run `jr-arch init` first.');
  return d;
}

const BLANK_SOUL = (name) => `---
name: ${name}
tier: 1
role: TODO — one line
---

# ${name}

What this tier owns, and why it exists as its own tier.

## How you work

## Voice

## Boundary

When to hand off, and to whom. Add the matching entry to ../../DUTIES.md.
`;

const BLANK_RULES = (name) => `# Rules — ${name}

## Must

## Must not

## Hand off when
`;

export async function personas(positional, flags) {
  const [action, name] = positional;

  if (!action || action === 'list') {
    const dir = tiersDir();
    console.log();
    for (const a of readAgents()) {
      const scope = a.owns.length ? c.d(`  ${a.owns.join(' ')}`) : '';
      const par = a.parallel ? c.g('  parallel') : '';
      console.log(`  ${c.c(a.name.padEnd(14))}${c.d(String(a.priority).padStart(3))}  ${a.role}${scope}${par}`);
    }
    console.log();
    info('edit  .gitagent/agents/<name>/RULES.md');
    info('add   jr-arch add-agent <git-url>');
    console.log();
    return;
  }

  if (action === 'add') {
    if (!name) throw new Error('Usage: jr-arch personas add <name> [--from <git-url>]');
    const dest = join(tiersDir(), name);
    if (existsSync(dest) && !flags.force) {
      throw new Error(`Persona "${name}" already exists. Use --force to overwrite.`);
    }

    if (flags.from) {
      // One persona out of any git repo — a pack repo, or an ordinary one with
      // a SOUL.md in it. fetchPack does the clone: it strips the nested .git,
      // resolves the commit, and refuses a url that would be read as a flag.
      // A second copy of that here is how the two would drift apart.
      const fetched = fetchPack(flags.from, { ref: typeof flags.ref === 'string' ? flags.ref : null });
      try {
        const candidates = [join('agents', name), name, '.'];
        const rel = candidates.find((p) => existsSync(join(fetched.dir, p, 'SOUL.md')));
        if (!rel) throw new Error(`No SOUL.md found for "${name}" in that repo.`);

        const src = join(fetched.dir, confine(fetched.dir, rel, `persona "${name}"`));

        // Shown before the copy, not after. Reviewing a persona you have
        // already installed is reviewing it too late.
        console.log();
        for (const f of ['SOUL.md', 'RULES.md']) {
          info(`${existsSync(join(src, f)) ? c.g('✓') : c.y('—')} ${f}`);
        }
        if (fetched.sha) info(`commit  ${fetched.sha.slice(0, 7)}`);
        console.log();
        warn('A pulled persona is untrusted input — read its RULES.md before running.');
        console.log();

        mkdirSync(dest, { recursive: true });
        cpSync(src, dest, { recursive: true, dereference: true });
        ok(`Added ${c.c(name)} from ${flags.from}`);
      } finally {
        fetched.cleanup();
      }
    } else {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'SOUL.md'), BLANK_SOUL(name));
      writeFileSync(join(dest, 'RULES.md'), BLANK_RULES(name));
      ok(`Created ${c.c(name)}`);
    }

    console.log();
    wire(name, 'add', roleOf(dest));
    // The table row is mechanical; the escalation rule is a decision about who
    // this tier hands to and when, and writing a guess into the contract file
    // would be worse than leaving the gap visible.
    info(`write its escalation rule in ${c.c('.gitagent/DUTIES.md')} — who does it hand to, and when?`);
    console.log();
    return;
  }

  if (action === 'remove') {
    if (!name) throw new Error('Usage: jr-arch personas remove <name>');
    const dest = join(tiersDir(), name);
    if (!existsSync(dest)) throw new Error(`No persona "${name}".`);
    rmSync(dest, { recursive: true, force: true });
    ok(`Removed ${name}`);
    console.log();
    wire(name, 'remove');
    console.log();
    return;
  }

  throw new Error(`Unknown personas action "${action}". Use list, add, or remove.`);
}

// ---------------------------------------------------------------------------
// Wiring a persona into the manifest and the contract
// ---------------------------------------------------------------------------

/**
 * A persona directory on its own does nothing.
 *
 * `agent.yaml` decides which tiers exist — the classifier refuses to route to
 * one that is not listed — and `DUTIES.md` is the contract the run loop reads
 * back to the model. Printing "now go and edit these two files" left a persona
 * that looked installed and was not, which is the worst of both.
 */
export function wire(name, action, role = '') {
  const dir = agentDir();
  patchAgents(join(dir, 'agent.yaml'), name, action);
  patchDuties(join(dir, 'DUTIES.md'), name, action, role);
}

function patchAgents(file, name, action) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  const current = readManifest(file).agents.map(String);
  const next = action === 'add'
    ? (current.includes(name) ? current : [...current, name])
    : current.filter((a) => a !== name);

  if (next.length === current.length && action === 'add') {
    info(`${c.d('agent.yaml')}  already lists ${name}`);
    return;
  }
  if (!next.length) {
    warn('agent.yaml would be left with no agents — leaving it alone.');
    return;
  }
  writeFileSync(file, patchSequence(text, 'agents', next));
  ok(`${c.d('agent.yaml')}  ${action === 'add' ? 'added' : 'removed'} ${c.c(name)}`);
}

/**
 * Insert or drop the tier's row in the DUTIES.md table.
 *
 * Scoped to the table under `## Tiers` rather than matched file-wide: the tier
 * name also appears in the escalation prose below it, and a loose replace
 * would rewrite the sentences that define the handoff graph. Same failure the
 * `metadata:`/`model:` bug had, in a different file.
 */
function patchDuties(file, name, action, role) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n');

  const head = lines.findIndex((l) => /^##\s+Tiers\b/.test(l));
  if (head === -1) {
    warn('DUTIES.md has no "## Tiers" table — add the row yourself.');
    return;
  }
  const end = lines.findIndex((l, i) => i > head && /^##\s/.test(l));
  const stop = end === -1 ? lines.length : end;

  const isRow = (l) => /^\|/.test(l.trim()) && !/^\|\s*-+/.test(l.trim());
  const rows = [];
  for (let i = head + 1; i < stop; i++) if (isRow(lines[i])) rows.push(i);
  if (rows.length < 2) {
    warn('DUTIES.md tier table not recognised — add the row yourself.');
    return;
  }

  // A persona name is user input; escape it before it becomes a pattern.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const owns = new RegExp(String.raw`^\|\s*` + '`?' + escaped + '`?' + String.raw`\s*\|`);
  const existing = rows.find((i) => owns.test(lines[i].trim()));

  if (action === 'remove') {
    if (existing === undefined) return;
    lines.splice(existing, 1);
    writeFileSync(file, lines.join('\n'));
    ok(`${c.d('DUTIES.md')}   removed the ${c.c(name)} row`);
    return;
  }

  if (existing !== undefined) {
    info(`${c.d('DUTIES.md')}   already describes ${name}`);
    return;
  }
  const row = `| \`${name}\` | ${role || 'TODO — what this tier owns'} | TODO — what it never does |`;
  lines.splice(rows[rows.length - 1] + 1, 0, row);
  writeFileSync(file, lines.join('\n'));
  ok(`${c.d('DUTIES.md')}   added the ${c.c(name)} row`);
}

/** The one-line role from a persona's SOUL.md front matter, if it has one. */
function roleOf(dir) {
  const soul = join(dir, 'SOUL.md');
  if (!existsSync(soul)) return '';
  const m = readFileSync(soul, 'utf8').match(/^role:\s*(.+)$/m);
  return m ? m[1].trim() : '';
}
