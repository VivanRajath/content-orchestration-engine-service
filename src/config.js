import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './paths.js';
import { parseYaml } from './yaml.js';
import { c, ok, info } from './util.js';

function manifestPath() {
  const p = join(agentDir(), 'agent.yaml');
  if (!existsSync(p)) throw new Error('No .gitagent/ found. Run `jr-architect init` first.');
  return p;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace `key:` inside the `section:` block only, and return the new text.
 *
 * `name:` appears under both `metadata:` and `model:`, so a file-wide replace
 * clobbers the wrong one. This is the only implementation of that scoping —
 * `init` and `config set` both call it. Two copies is how the bug got in.
 *
 * Line-based rather than one big regex: a block that ends at EOF or runs past
 * blank lines is fiddly to express and easy to get subtly wrong.
 */
export function patchSection(text, section, key, value) {
  const lines = text.split('\n');
  const head = lines.findIndex((l) => l.startsWith(`${section}:`));
  if (head === -1) throw new Error(`Section "${section}:" not found in agent.yaml`);

  const keyRe = new RegExp(`^(\\s+${escapeRe(key)}:)`);
  for (let i = head + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;      // a blank line does not end the block
    if (!/^[ \t]/.test(line)) break;       // a dedent to column 0 does
    const m = line.match(keyRe);
    // Assign, don't String.replace — a value containing $& or $1 would expand.
    if (m) { lines[i] = `${m[1]} ${value}`; return lines.join('\n'); }
  }
  throw new Error(`Key "${section}.${key}" not found in agent.yaml`);
}

/**
 * Read agent.yaml.
 *
 * This was a set of section-scoped regexes reading five flat scalars. The run
 * loop needs the routing block as well, and CLAUDE.md's own note on the old
 * reader said to add a real parser rather than stretch the regexes once
 * manifest handling grew — src/yaml.js is that parser. One reader, not two:
 * duplicate readers of this file is the shape of bug `config set` just had.
 */
export function readManifest(file = manifestPath()) {
  const doc = parseYaml(readFileSync(file, 'utf8'), 'agent.yaml') ?? {};
  const model = doc.model ?? {};
  const routing = doc.routing ?? {};
  const nil = (v) => (v === undefined || v === '' ? null : v);

  return {
    provider: nil(model.provider),
    model:    nil(model.name),
    keyEnv:   nil(model.api_key_env),
    baseUrl:  nil(model.base_url),
    entry:    nil(routing.entry),

    temperature: nil(model.temperature),
    maxTokens:   nil(model.max_tokens),

    juniorRetryLimit: routing.junior_retry_limit ?? 2,
    seniorRetryLimit: routing.senior_retry_limit ?? 2,
    diffCeiling:      routing.diff_line_ceiling ?? 400,
    confidenceFloor:  routing.classifier_confidence_floor ?? 0.6,
    degradedFallback: nil(routing.degraded_fallback) ?? 'senior-dev',

    agents:   Array.isArray(doc.agents) ? doc.agents : [],
    identity: doc.identity ?? {},
    memory:   doc.memory ?? {},
    raw:      doc,
  };
}

export async function config(positional, _flags) {
  const [action, path, value] = positional;

  if (!action || action === 'show' || action === 'get') {
    const m = readManifest();
    console.log();
    console.log(c.b('  model'));
    info(`provider     ${m.provider}`);
    info(`name         ${m.model}`);
    info(`api_key_env  ${m.keyEnv}${process.env[m.keyEnv] ? c.g('  (set)') : c.y('  (not set)')}`);
    info(`base_url     ${m.baseUrl ?? '—'}`);
    console.log(c.b('  routing'));
    info(`entry        ${m.entry}`);
    console.log();
    return;
  }

  if (action === 'set') {
    if (!path || value === undefined) {
      throw new Error('Usage: jr-architect config set <section.key> <value>\n  e.g. config set model.name gpt-4o');
    }
    const [section, key] = path.split('.');
    if (!section || !key) throw new Error(`Expected <section.key>, got "${path}"`);

    const p = manifestPath();
    writeFileSync(p, patchSection(readFileSync(p, 'utf8'), section, key, value));
    ok(`${path} = ${value}`);
    return;
  }

  throw new Error(`Unknown config action "${action}". Use show or set.`);
}
