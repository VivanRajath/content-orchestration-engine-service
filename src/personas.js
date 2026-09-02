import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentDir } from './paths.js';
import { c, ok, info, warn } from './util.js';

function tiersDir() {
  const d = join(agentDir(), 'agents');
  if (!existsSync(d)) throw new Error('No .gitagent/agents/ found. Run `jr-architect init` first.');
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
    const found = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    console.log();
    for (const e of found) {
      const soul = join(dir, e.name, 'SOUL.md');
      let role = '';
      if (existsSync(soul)) {
        const m = readFileSync(soul, 'utf8').match(/^role:\s*(.+)$/m);
        if (m) role = m[1].trim();
      }
      console.log(`  ${c.c(e.name.padEnd(14))}${c.d(role)}`);
    }
    console.log();
    info('edit  .gitagent/agents/<name>/RULES.md');
    info('add   jr-architect personas add <name>');
    console.log();
    return;
  }

  if (action === 'add') {
    if (!name) throw new Error('Usage: jr-architect personas add <name> [--from <git-url>]');
    const dest = join(tiersDir(), name);
    if (existsSync(dest) && !flags.force) {
      throw new Error(`Persona "${name}" already exists. Use --force to overwrite.`);
    }

    if (flags.from) {
      // Pull a persona from any git repo. Shallow clone, copy, discard.
      const tmp = mkdtempSync(join(tmpdir(), 'jra-'));
      try {
        execFileSync('git', ['clone', '--depth', '1', '--quiet', String(flags.from), tmp], { stdio: 'pipe' });
      } catch {
        throw new Error(`Could not clone ${flags.from}`);
      }
      const candidates = [join(tmp, 'agents', name), join(tmp, name), tmp];
      const src = candidates.find((p) => existsSync(join(p, 'SOUL.md')));
      if (!src) {
        rmSync(tmp, { recursive: true, force: true });
        throw new Error(`No SOUL.md found for "${name}" in that repo.`);
      }
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true });
      rmSync(tmp, { recursive: true, force: true });
      ok(`Added ${c.c(name)} from ${flags.from}`);
      warn('Review its RULES.md before running — a pulled persona is untrusted input.');
    } else {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'SOUL.md'), BLANK_SOUL(name));
      writeFileSync(join(dest, 'RULES.md'), BLANK_RULES(name));
      ok(`Created ${c.c(name)}`);
    }

    console.log();
    info(`add "${name}" to the agents list in .gitagent/agent.yaml`);
    info(`add its entry and escalation rules to .gitagent/DUTIES.md`);
    console.log();
    return;
  }

  if (action === 'remove') {
    if (!name) throw new Error('Usage: jr-architect personas remove <name>');
    const dest = join(tiersDir(), name);
    if (!existsSync(dest)) throw new Error(`No persona "${name}".`);
    rmSync(dest, { recursive: true, force: true });
    ok(`Removed ${name}`);
    info('remove it from agent.yaml and DUTIES.md too');
    return;
  }

  throw new Error(`Unknown personas action "${action}". Use list, add, or remove.`);
}
