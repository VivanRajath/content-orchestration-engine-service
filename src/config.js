import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './paths.js';
import { parseYaml } from './yaml.js';
import { c, ok, info } from './util.js';

function manifestPath() {
  const p = join(agentDir(), 'agent.yaml');
  if (!existsSync(p)) throw new Error('No .gitagent/ found. Run `jr-arch init` first.');
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
 * Replace a top-level block sequence (`agents:` and its `- ` items).
 *
 * patchSection cannot do this: it replaces one scalar inside a mapping, and
 * the item count here changes with the pack. Same line-based approach and the
 * same reason — the block ends at the next line in column 0, not at a blank.
 */
export function patchSequence(text, key, items) {
  const lines = text.split('\n');
  const head = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (head === -1) throw new Error(`Key "${key}:" not found in agent.yaml`);

  let end = head + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '' || /^[ \t]/.test(line) || line.trimStart().startsWith('#')) { end++; continue; }
    break;
  }
  // Trailing blank lines belong to the gap before the next section, not to
  // this block — leaving them in collapses the spacing a little more on every
  // rewrite until the file is one dense wall.
  while (end > head + 1 && lines[end - 1].trim() === '') end--;

  const body = items.map((i) => `  - ${i}`);
  return [...lines.slice(0, head), `${key}:`, ...body, ...lines.slice(end)].join('\n');
}

/**
 * Add or replace a whole top-level section, preserving the rest of the file.
 *
 * `source:` does not exist in the shipped agent.yaml — it only appears once a
 * pack has been installed — so this both creates and updates. Rewriting the
 * file through a YAML serializer instead would drop every comment in it, and
 * the comments in that manifest are half its documentation.
 */
export function upsertSection(text, key, body) {
  const block = `${key}:\n${body.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n')}`;
  const lines = text.split('\n');
  const head = lines.findIndex((l) => l.startsWith(`${key}:`));

  if (head === -1) {
    const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return `${text}${sep}${block}\n`;
  }

  let end = head + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) end++;
  while (end > head + 1 && lines[end - 1].trim() === '') end--;
  return [...lines.slice(0, head), ...block.split('\n'), ...lines.slice(end)].join('\n');
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
    // Absent until a pack is installed; `pull` reads it to know where to go
    // back to, and readManifest is the one reader of this file.
    source:   doc.source ?? null,
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
      throw new Error('Usage: jr-arch config set <section.key> <value>\n  e.g. config set model.name gpt-4o');
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
