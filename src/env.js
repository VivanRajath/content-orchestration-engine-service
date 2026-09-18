import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir, repoRoot } from './paths.js';
import { keyEnvs, modelFor, addSavedKey, readManifest, patchSection, patchTierModel } from './config.js';
import { PROVIDERS, detectProvider, providerFor } from './providers.js';
import { readAgents } from './agents.js';
import { c, ok, info, warn } from './util.js';

/**
 * The key, and where it lives.
 *
 * `agent.yaml` names an environment VARIABLE, never a value — that decision is
 * load-bearing and does not change here. What changes is that the variable can
 * now come from `.gitagent/.env` as well as the shell, because "export it
 * yourself" is a bad answer on Windows, where `export` is not even valid
 * syntax, and because `init` has always gitignored that file while nothing
 * ever read it.
 *
 * The shell still wins. A variable someone exported deliberately for this
 * command should not be silently overridden by a file they set up weeks ago.
 */

export const ENV_FILE = '.env';

/** Names loadEnv put into process.env this run, so keySource can be honest. */
const fromFile = new Set();

/**
 * Parse KEY=value lines. Not a dotenv clone: no interpolation.
 *
 * Forgiving about what a person types by hand: `export NAME=value` (a shell
 * habit), spaces around the =, CRLF line endings, and a byte-order mark at the
 * start — Notepad's UTF-8 used to add one, and it silently turned the first
 * key's name into something no provider variable matches.
 */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text ?? '').replace(/^﻿/, '').split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Quotes are stripped, because a key pasted out of a shell command often
    // arrives wearing them and the resulting 401 is impossible to diagnose.
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/**
 * Load `.gitagent/.env` into process.env, without clobbering what is already
 * there. Returns the names it set, for a caller that wants to say so.
 */
export function loadEnv(dir = agentDir()) {
  const file = join(dir, ENV_FILE);
  if (!existsSync(file)) return [];

  let parsed;
  try {
    parsed = parseEnv(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }

  const applied = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v;
      fromFile.add(k);
      applied.push(k);
    }
  }
  return applied;
}

/**
 * Refuse to write a key anywhere git could pick it up.
 *
 * This is the whole reason the manifest stores a variable name instead of a
 * value. Writing the value to disk is only acceptable while the file is
 * genuinely ignored, so the rule is verified — and added — before the write,
 * not after it.
 */
export function ensureIgnored(root = repoRoot()) {
  const file = join(root, '.gitignore');
  const rule = '.gitagent/.env';
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split('\n').some((l) => l.trim() === rule || l.trim() === '.gitagent/.env*')) return true;

  appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}\n# jr-arch — never commit a key\n${rule}\n`);
  return false;
}

/**
 * A variable name for one more key of a provider already in use.
 *
 * GROQ_API_KEY, then GROQ_API_KEY_2, and so on. Writing a second Groq key into
 * GROQ_API_KEY would silently replace the first, and every agent using it would
 * move to the new one without anyone deciding that.
 */
export function nextKeyEnv(base, taken = []) {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** First four characters and a length. Never the whole key, anywhere. */
export function fingerprint(value) {
  const s = String(value ?? '');
  if (!s) return '';
  return `${s.slice(0, 4)}… (${s.length} chars)`;
}

/**
 * What a fresh `.gitagent/.env` says, so someone who opens it knows what to type.
 *
 * The file is created at setup whether or not a key has been pasted yet: it is
 * the place a person working in the folder — /dev, an editor, no chat at all —
 * puts a key, and a place that does not exist yet is not a place anyone finds.
 */
export function envTemplate() {
  return [
    '# API keys for jr-arch, one per line: NAME=value',
    '#',
    '# This file is gitignored, readable only by you, and the agents cannot read',
    '# it (.env* is a sealed guardrail path). jr-arch reads it when it starts and',
    '# again before every message in the chat, so a key added here works without',
    '# restarting. A variable set in your shell wins over this file.',
    '#',
    '# Name a key after its provider. A second key for the same provider gets a',
    '# number: GROQ_API_KEY_2. Every key here shows up in /keys, and in /models',
    '# and /prompt when choosing which key an agent uses.',
    '#',
    ...Object.values(PROVIDERS).filter((p) => !p.noKey && p.keyPattern).map((p) => `# ${p.keyEnv}=`),
    '',
  ].join('\n');
}

/** Create `.gitagent/.env` with its instructions, if it is not there yet. */
export function ensureEnvFile(dir = agentDir(), root = repoRoot()) {
  const file = join(dir, ENV_FILE);
  if (existsSync(file)) return false;
  // Ignored before it exists, never after — even empty of keys, it is the file
  // someone will paste one into.
  ensureIgnored(root);
  writeFileSync(file, envTemplate(), { mode: 0o600 });
  return true;
}

const lineFor = (name) => new RegExp(`^\\s*(?:export\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);

/**
 * Set one key, touching only its own line.
 *
 * This used to rebuild the whole file from its parsed pairs, which was fine
 * while only jr-arch wrote it. Now that it is also the file a person edits, a
 * rewrite would delete every comment and placeholder they left in it. So: the
 * key's own line is replaced; failing that, its `# NAME=` placeholder becomes
 * the real line; failing that, it is appended.
 */
export function writeKey(name, value, dir = agentDir()) {
  const file = join(dir, ENV_FILE);
  const lines = (existsSync(file) ? readFileSync(file, 'utf8') : envTemplate())
    .replace(/^﻿/, '').split(/\r?\n/);
  const entry = `${name}=${value}`;

  const at = lines.findIndex((l) => lineFor(name).test(l));
  const placeholder = lines.findIndex((l) => l.trim() === `# ${name}=`);
  if (at >= 0) lines[at] = entry;
  else if (placeholder >= 0) lines[placeholder] = entry;
  else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(entry);
  }
  writeFileSync(file, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });

  // This value now belongs to the file, so a later edit of the file updates it
  // — unless the shell set this variable, which always wins.
  if (process.env[name] === undefined || process.env[name] === '' || fromFile.has(name)) fromFile.add(name);
}

export function removeKey(name, dir = agentDir()) {
  const file = join(dir, ENV_FILE);
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const at = lines.findIndex((l) => lineFor(name).test(l));
  if (at < 0) return false;
  lines.splice(at, 1);
  writeFileSync(file, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
  if (fromFile.has(name)) { delete process.env[name]; fromFile.delete(name); }
  return true;
}

/**
 * Read the file again, for a key someone added while the chat was open.
 *
 * Same rule as loadEnv, the shell wins: a variable exported in the terminal is
 * never touched. One that came from this file is updated when the file
 * changes, and forgotten when its line is deleted. Returns the names that
 * changed, so the chat can say what it picked up.
 */
export function reloadEnv(dir = agentDir()) {
  const file = join(dir, ENV_FILE);
  let parsed = {};
  try { if (existsSync(file)) parsed = parseEnv(readFileSync(file, 'utf8')); } catch { return []; }

  const changed = [];
  for (const [k, v] of Object.entries(parsed)) {
    const shellOwned = process.env[k] !== undefined && process.env[k] !== '' && !fromFile.has(k);
    if (shellOwned || process.env[k] === v) continue;
    process.env[k] = v;
    fromFile.add(k);
    changed.push(k);
  }
  for (const k of [...fromFile]) {
    if (k in parsed) continue;
    delete process.env[k];
    fromFile.delete(k);
    changed.push(k);
  }
  return changed;
}

/** Which provider a variable belongs to: by its name first, then by its value. */
export function providerOfVar(name, value) {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (p.noKey || !p.keyPattern) continue;
    if (name === p.keyEnv || name.startsWith(`${p.keyEnv}_`)) return id;
  }
  return detectProvider(value);
}

/**
 * Keys in the file that no setting mentions yet, recorded so they can be used.
 *
 * Without this a key typed straight into `.gitagent/.env` under a new name —
 * GROQ_API_KEY_5, or ANTHROPIC_API_KEY in a Groq repo — was loaded and then
 * never offered anywhere, because the lists of keys come from agent.yaml.
 * An OpenAI-compatible key is left alone: it is useless without a base URL,
 * which only a person can supply.
 */
export function discoverKeys(dir = agentDir()) {
  const file = join(dir, ENV_FILE);
  const manifestFile = join(dir, 'agent.yaml');
  if (!existsSync(file) || !existsSync(manifestFile)) return [];

  let parsed;
  try { parsed = parseEnv(readFileSync(file, 'utf8')); } catch { return []; }
  const known = new Set(keyEnvs(readManifest(manifestFile)));

  const found = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (!value || known.has(name)) continue;
    const provider = providerOfVar(name, value);
    if (!provider || provider === 'openai-compatible') continue;
    if (addSavedKey({ provider, keyEnv: name }, manifestFile)) found.push({ name, provider });
  }
  return found;
}

// ---------------------------------------------------------------------------
// A key pasted into agent.yaml
// ---------------------------------------------------------------------------

/**
 * Does this look like a key rather than the NAME of the variable holding one?
 *
 * agent.yaml asks for `api_key_env`, a variable name, and a person editing the
 * folder by hand will sometimes paste the key itself there instead. That file
 * is committed. A name is a plain identifier; a key has a provider's prefix or
 * characters no variable name can.
 */
export function looksLikeKeyValue(v) {
  const s = String(v ?? '').trim();
  if (!s) return false;
  if (detectProvider(s)) return true;
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

/** Every api_key_env in the manifest that holds a key instead of a name. */
export function misplacedKeys(manifest) {
  const out = [];
  if (looksLikeKeyValue(manifest.keyEnv)) {
    out.push({ where: 'model.api_key_env', tier: null, value: String(manifest.keyEnv), provider: manifest.provider });
  }
  for (const [tier, spec] of Object.entries(manifest.tiers ?? {})) {
    const v = spec?.model?.api_key_env;
    if (looksLikeKeyValue(v)) {
      out.push({ where: `tiers.${tier}.model.api_key_env`, tier, value: String(v), provider: spec.model.provider ?? manifest.provider });
    }
  }
  return out;
}

/**
 * Move one pasted key into `.gitagent/.env`, and put its variable's name back
 * where agent.yaml expects a name. Returns that name.
 */
export function moveMisplacedKey(entry, dir = agentDir(), root = repoRoot()) {
  const manifestFile = join(dir, 'agent.yaml');
  const provider = detectProvider(entry.value) ?? entry.provider;
  const base = providerFor(provider)?.keyEnv ?? 'LLM_API_KEY';
  const file = join(dir, ENV_FILE);
  const existing = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const same = Object.entries(existing).find(([, v]) => v === entry.value);
  const name = same ? same[0] : nextKeyEnv(base, Object.keys(existing));

  ensureIgnored(root);
  writeKey(name, entry.value, dir);
  process.env[name] = entry.value;

  let text = readFileSync(manifestFile, 'utf8');
  text = entry.tier
    ? patchTierModel(text, entry.tier, 'api_key_env', name).text
    : patchSection(text, 'model', 'api_key_env', name);
  writeFileSync(manifestFile, text);
  return name;
}

/**
 * Where the value in process.env actually came from.
 *
 * Answered from what loadEnv actually did, not inferred afterwards. Once the
 * variable is in process.env the two sources are indistinguishable by
 * inspection, and a status line that guesses wrong sends someone editing the
 * wrong place.
 */
export function keySource(name) {
  if (!process.env[name]) return null;
  return fromFile.has(name) ? '.gitagent/.env' : 'your environment';
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function key(positional, flags, { manifest }) {
  let name = typeof flags.env === 'string' ? flags.env : manifest.keyEnv;
  if (!name) {
    throw new Error('agent.yaml does not name an api_key_env. Set one:\n  jr-arch config set model.api_key_env MY_KEY');
  }

  const [action] = positional;

  if (action === 'remove' || action === 'unset') {
    const had = removeKey(name);
    had ? ok(`Removed ${c.c(name)} from .gitagent/.env`) : warn(`${name} was not in .gitagent/.env`);
    return;
  }

  // `jr-arch key <value>` and `jr-arch key set <value>` both work; someone
  // reaching for this command is not in the mood to read a usage line.
  const value = action === 'set' ? positional[1] : action;

  if (!value) {
    console.log();
    // Every variable the manifest references, not just the default one. With
    // per-tier models a run can need several keys, and "the key is set" is a
    // useless answer when the tier that fails is the one missing its own.
    const needed = keyEnvs(manifest);
    for (const varName of needed) {
      const tiers = readAgents().map((a) => a.name).filter((t) => modelFor(manifest, t).keyEnv === varName);
      const used = tiers.length && needed.length > 1 ? c.d(`  ${tiers.join(', ')}`) : '';
      if (process.env[varName]) {
        ok(`${c.c(varName.padEnd(22))}${fingerprint(process.env[varName])} ${c.d(`from ${keySource(varName)}`)}${used}`);
      } else {
        warn(`${c.c(varName.padEnd(22))}not set${used}`);
      }
    }
    if (!needed.every((n) => process.env[n])) {
      console.log();
      info(`set one:  jr-arch key <your-key>${needed.length > 1 ? '  --env <NAME>' : ''}`);
    }
    console.log();
    return;
  }

  if (/^\s*$/.test(value)) throw new Error('That key is empty.');

  // A key belongs to its own provider's variable. `jr-arch key sk-ant-...` in
  // a repo set up for Groq used to be written into GROQ_API_KEY — the Anthropic
  // key sent to Groq on the next request, and the working Groq key gone.
  const detected = typeof flags.env === 'string' ? null : detectProvider(value.trim());
  if (detected && detected !== manifest.provider) {
    name = providerFor(detected).keyEnv;
    info(`That looks like a ${providerFor(detected).label} key, so it is saved as ${c.c(name)} — your ${c.c(manifest.keyEnv)} is left as it is.`);
    try { addSavedKey({ provider: detected, keyEnv: name }); } catch { /* the key still lands */ }
    info(c.d('Put an agent on it with /models in the chat.'));
  }

  const alreadyIgnored = ensureIgnored();
  writeKey(name, value.trim());

  ok(`${c.c(name)} written to ${c.c('.gitagent/.env')} — ${fingerprint(value.trim())}`);
  if (!alreadyIgnored) info('added .gitagent/.env to .gitignore');
  info('this file is ignored by git and read on every run');
  // The agent cannot reach it either: `.env*` is a sealed protected-read path,
  // so the model it belongs to cannot cat its own key back out.
  info(`the agent itself cannot read it — ${c.d('.env* is a sealed guardrail path')}`);
  console.log();
}
