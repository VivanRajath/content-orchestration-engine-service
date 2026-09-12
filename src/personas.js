import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './paths.js';
import { fetchPack, confine } from './pack.js';
import { readAgents } from './agents.js';
import { c, ok, info, warn } from './util.js';

function tiersDir() {
  const d = join(agentDir(), 'agents');
  if (!existsSync(d)) throw new Error('No .gitagent/agents/ found. Run `jr-arch init` first.');
  return d;
}

const BLANK_SOUL = (name) => `---
name: ${name}
role: TODO — one line
priority: 50              # lower numbers claim work first
parallel: false           # true only if \`owns\` is set and does not overlap
owns: []                  # globs this agent claims; empty means anything
# escalates_to: other-agent   who takes over when this one runs out of attempts
# terminal: true              instead: stop and ask the human
---

# ${name}

What this agent owns, and why it exists separately from the others.

## How you work

## Voice

## Boundary

When to hand off, and to whom.
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

    // Nothing else to wire. The directory is what installs an agent, and its
    // own front matter is where priority, scope and escalation live — there is
    // no manifest list and no table to keep in step.
    console.log();
    info(`set its priority, owns and escalates_to in ${c.c(`agents/${name}/SOUL.md`)}`);
    console.log();
    return;
  }

  if (action === 'remove') {
    if (!name) throw new Error('Usage: jr-arch personas remove <name>');
    const dest = join(tiersDir(), name);
    if (!existsSync(dest)) throw new Error(`No persona "${name}".`);
    rmSync(dest, { recursive: true, force: true });
    ok(`Removed ${name}`);
    return;
  }

  throw new Error(`Unknown personas action "${action}". Use list, add, or remove.`);
}
