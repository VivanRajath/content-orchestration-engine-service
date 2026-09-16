import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './paths.js';
import { parseYaml } from './yaml.js';
import { readAgents } from './agents.js';
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
 * Set a scalar that may not be there yet.
 *
 * `patchSection` replaces a key that exists and throws when it does not, which
 * is right for `config set` — a typo should not silently invent a key. Writing
 * a limit is the other case: `max_tokens` is optional in the file, and the
 * whole point is to add it. So this falls back to inserting the key at the
 * indentation the block already uses.
 */
export function upsertScalar(text, section, key, value) {
  try {
    return patchSection(text, section, key, value);
  } catch (err) {
    if (!/not found in agent.yaml$/.test(err.message)) throw err;
  }

  const lines = text.split('\n');
  const head = lines.findIndex((l) => l.startsWith(`${section}:`));
  if (head === -1) throw new Error(`Section "${section}:" not found in agent.yaml`);
  const end = blockEnd(lines, head);
  const indent = indentOfBlock(lines, head + 1, end) ?? '  ';
  // After the last real line of the block, not after its trailing comments:
  // a comment at the end of a block is usually about the block, not about the
  // key that happens to follow it.
  let at = end;
  while (at > head + 1 && (lines[at - 1].trim() === '' || lines[at - 1].trim().startsWith('#'))) at--;
  return [...lines.slice(0, at), `${indent}${key}: ${value}`, ...lines.slice(at)].join('\n');
}

/** Where a top-level block ends: the next line in column 0, blanks trimmed. */
function blockEnd(lines, head) {
  let end = head + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) end++;
  while (end > head + 1 && lines[end - 1].trim() === '') end--;
  return end;
}

const leading = (line) => line.match(/^[ \t]*/)[0];

/** The indentation the children of a block are written at. */
function indentOfBlock(lines, from, to) {
  for (let i = from; i < to; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    return leading(line);
  }
  return null;
}

/** The line index of `key:` among the direct children of a block, or -1. */
function childAt(lines, from, to, key) {
  const indent = indentOfBlock(lines, from, to);
  if (indent === null) return -1;
  const re = new RegExp(`^${indent}${escapeRe(key)}:`);
  for (let i = from; i < to; i++) {
    if (!lines[i].trim() || lines[i].trim().startsWith('#')) continue;
    if (leading(lines[i]).length !== indent.length) continue;
    if (re.test(lines[i])) return i;
  }
  return -1;
}

/** Where a nested block ends: the next line indented no deeper than its head. */
function childEnd(lines, head, to) {
  const indent = leading(lines[head]).length;
  let end = head + 1;
  while (end < to) {
    const line = lines[end];
    if (line.trim() === '' || leading(line).length > indent) { end++; continue; }
    break;
  }
  while (end > head + 1 && lines[end - 1].trim() === '') end--;
  return end;
}

/**
 * Set or remove one scalar under `tiers.<agent>.model`, creating whatever part
 * of the path is missing and leaving everything else — including comments —
 * exactly where it was.
 *
 * Deliberately NOT a read-modify-serialize of the parsed document. `tiers:` is
 * where a user writes down which model each agent gets and why, and rewriting
 * the block from the parse tree drops every comment in it. Same rule as the
 * rest of this file: agent.yaml is edited by line.
 *
 * Returns `{text, changed}`; `changed` is false when there was nothing to
 * remove, so a caller can say "that agent had no cap" rather than claiming to
 * have done something.
 */
export function patchTierModel(text, agent, key, value) {
  const removing = value === null;
  const lines = text.split('\n');
  const head = lines.findIndex((l) => l.startsWith('tiers:'));

  if (head === -1) {
    if (removing) return { text, changed: false };
    // No tiers: block at all. upsertSection appends one; the commented-out
    // example in the shipped manifest is not matched, and must not be, or the
    // write would land inside a comment.
    const body = [`${agent}:`, '  model:', `    ${key}: ${value}`].join('\n');
    return { text: upsertSection(text, 'tiers', body), changed: true };
  }

  const end = blockEnd(lines, head);
  const tierIndent = indentOfBlock(lines, head + 1, end) ?? '  ';
  const agentAt = childAt(lines, head + 1, end, agent);

  if (agentAt === -1) {
    if (removing) return { text, changed: false };
    const block = [
      `${tierIndent}${agent}:`,
      `${tierIndent}${tierIndent}model:`,
      `${tierIndent}${tierIndent}${tierIndent}${key}: ${value}`,
    ];
    let at = end;
    while (at > head + 1 && (lines[at - 1].trim() === '' || lines[at - 1].trim().startsWith('#'))) at--;
    return { text: [...lines.slice(0, at), ...block, ...lines.slice(at)].join('\n'), changed: true };
  }

  const agentEnd = childEnd(lines, agentAt, end);
  const modelAt = childAt(lines, agentAt + 1, agentEnd, 'model');

  if (modelAt === -1) {
    if (removing) return { text, changed: false };
    const indent = indentOfBlock(lines, agentAt + 1, agentEnd) ?? `${tierIndent}${tierIndent}`;
    const block = [`${indent}model:`, `${indent}${tierIndent}${key}: ${value}`];
    return { text: [...lines.slice(0, agentEnd), ...block, ...lines.slice(agentEnd)].join('\n'), changed: true };
  }

  const modelEnd = childEnd(lines, modelAt, agentEnd);
  const keyAt = childAt(lines, modelAt + 1, modelEnd, key);

  if (keyAt !== -1) {
    if (removing) {
      // Take the empty parents with it. A `model:` with nothing under it parses
      // as null and is harmless, but it reads as configuration that is there,
      // and the next person to open the file has to work out that it is not.
      // Each index below sits above the one before it, so deleting a later line
      // never moves an earlier one.
      let rest = [...lines.slice(0, keyAt), ...lines.slice(keyAt + 1)];
      rest = pruneIfEmpty(rest, modelAt);
      rest = pruneIfEmpty(rest, agentAt);
      rest = pruneIfEmpty(rest, head);
      return { text: rest.join('\n'), changed: true };
    }
    const indent = leading(lines[keyAt]);
    const next = [...lines];
    next[keyAt] = `${indent}${key}: ${value}`;
    return { text: next.join('\n'), changed: true };
  }

  if (removing) return { text, changed: false };
  const indent = indentOfBlock(lines, modelAt + 1, modelEnd) ?? `${leading(lines[modelAt])}${tierIndent}`;
  return {
    text: [...lines.slice(0, modelEnd), `${indent}${key}: ${value}`, ...lines.slice(modelEnd)].join('\n'),
    changed: true,
  };
}

/** Drop a `key:` line that no longer has anything under it. */
function pruneIfEmpty(lines, at) {
  if (at < 0 || at >= lines.length) return lines;
  const indent = leading(lines[at]).length;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (leading(line).length > indent) return lines;   // still has children
    break;
  }
  const rest = [...lines.slice(0, at), ...lines.slice(at + 1)];
  // A top-level block leaves the blank line that separated it behind.
  if (indent === 0) {
    while (at > 0 && rest[at - 1]?.trim() === '' && (rest[at]?.trim() === '' || rest[at] === undefined)) {
      rest.splice(at - 1, 1);
      break;
    }
  }
  return rest;
}

/** The reply cap every agent inherits. */
export function setModelMaxTokens(value, file = manifestPath()) {
  writeFileSync(file, upsertScalar(readFileSync(file, 'utf8'), 'model', 'max_tokens', value));
}

/**
 * What the provider said this key may spend a minute, as last measured.
 *
 * Written from the rate-limit headers rather than typed by anyone: it is a fact
 * about the key, it changes when the plan changes, and `jr-arch limits`
 * refreshes it.
 */
export function setTokensPerMinute(value, file = manifestPath()) {
  writeFileSync(file, upsertScalar(readFileSync(file, 'utf8'), 'model', 'tokens_per_minute', value));
}

/** One agent's own reply cap, in the user's manifest — never in its SOUL.md. */
export function setTierMaxTokens(agent, value, file = manifestPath()) {
  const { text } = patchTierModel(readFileSync(file, 'utf8'), agent, 'max_tokens', value);
  writeFileSync(file, text);
}

export function clearTierMaxTokens(agent, file = manifestPath()) {
  const { text, changed } = patchTierModel(readFileSync(file, 'utf8'), agent, 'max_tokens', null);
  if (changed) writeFileSync(file, text);
  return changed;
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
    // What the key allows per minute, measured at setup. Null until it is.
    tokensPerMinute: nil(model.tokens_per_minute),

    // One number, not one per agent name. An agent that wants a different
    // budget declares `attempts:` in its own front matter.
    defaultAttempts: routing.default_attempts ?? routing.junior_retry_limit ?? 2,
    confidenceFloor:  routing.classifier_confidence_floor ?? 0.6,
    // No default name. pickFallback uses the last agent by priority when this
    // is unset, which works whatever the installed agents are called.
    degradedFallback: nil(routing.degraded_fallback),

    // Absent until a pack is installed; `pull` reads it to know where to go
    // back to, and readManifest is the one reader of this file.
    source:   doc.source ?? null,
    // Per-tier model overrides. Empty for the common case of one model.
    tiers:    doc.tiers && typeof doc.tiers === 'object' && !Array.isArray(doc.tiers) ? doc.tiers : {},
    raw:      doc,
  };
}

/**
 * The manifest as a given tier sees it.
 *
 * A ladder whose whole premise is that tiers differ in cost and judgement
 * should be able to point them at different models: a cheap one for scoped
 * junior work, an expensive one for architecture. Anything a tier does not
 * override is inherited, so the common case — one model everywhere — needs no
 * `tiers:` block at all.
 *
 * Returns the same shape readManifest does, because every consumer (provider,
 * classifier, doctor, the run loop) already speaks it. A second shape would
 * mean every one of them learning which to expect.
 */
export function modelFor(manifest, tier) {
  const over = manifest.tiers?.[tier]?.model;
  if (!over || typeof over !== 'object') return manifest;

  const nil = (v) => (v === undefined || v === '' ? null : v);
  const pick = (key, fallback) => (over[key] === undefined ? fallback : nil(over[key]));

  return {
    ...manifest,
    provider: pick('provider', manifest.provider),
    model:    pick('name', manifest.model),
    keyEnv:   pick('api_key_env', manifest.keyEnv),
    // base_url follows the provider unless the tier names its own. Inheriting
    // a base_url across a provider change points an Anthropic tier at an
    // OpenAI-compatible endpoint, which fails in a way nobody can read.
    baseUrl:  over.base_url === undefined
      ? (over.provider && over.provider !== manifest.provider ? null : manifest.baseUrl)
      : nil(over.base_url),
    temperature: pick('temperature', manifest.temperature),
    maxTokens:   pick('max_tokens', manifest.maxTokens),
    // An agent on another provider has that provider's allowance, not this one.
    tokensPerMinute: over.provider && over.provider !== manifest.provider
      ? pick('tokens_per_minute', null)
      : pick('tokens_per_minute', manifest.tokensPerMinute),
    tier,
  };
}

/** Every env var name the manifest references, base and per-tier. */
export function keyEnvs(manifest) {
  const names = new Set();
  if (manifest.keyEnv) names.add(manifest.keyEnv);
  for (const spec of Object.values(manifest.tiers ?? {})) {
    if (spec?.model?.api_key_env) names.add(String(spec.model.api_key_env));
  }
  return [...names];
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
    if (Object.keys(m.tiers).length) {
      console.log(c.b('  per tier'));
      for (const tier of readAgents().map((a) => a.name)) {
        const t = modelFor(m, tier);
        const overridden = t.model !== m.model || t.provider !== m.provider || t.keyEnv !== m.keyEnv;
        const set = process.env[t.keyEnv] ? c.g('set') : c.y('not set');
        info(`${tier.padEnd(14)}${overridden ? `${t.model}  ${c.d(`${t.provider} · ${t.keyEnv} ${set}`)}` : c.d('(inherits)')}`);
      }
    }
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
