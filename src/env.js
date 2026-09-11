import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir, repoRoot } from './paths.js';
import { keyEnvs, modelFor } from './config.js';
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

/** Parse KEY=value lines. Not a dotenv clone: no interpolation, no export. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
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

/** First four characters and a length. Never the whole key, anywhere. */
export function fingerprint(value) {
  const s = String(value ?? '');
  if (!s) return '';
  return `${s.slice(0, 4)}… (${s.length} chars)`;
}

export function writeKey(name, value, dir = agentDir()) {
  const file = join(dir, ENV_FILE);
  const existing = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  existing[name] = value;

  const body = [
    '# Read by jr-arch. Never committed — .gitignore covers this file.',
    '# The shell wins: a variable exported in your terminal overrides this.',
    ...Object.entries(existing).map(([k, v]) => `${k}=${v}`),
  ].join('\n');
  writeFileSync(file, `${body}\n`, { mode: 0o600 });
}

export function removeKey(name, dir = agentDir()) {
  const file = join(dir, ENV_FILE);
  if (!existsSync(file)) return false;
  const existing = parseEnv(readFileSync(file, 'utf8'));
  if (!(name in existing)) return false;
  delete existing[name];
  const lines = Object.entries(existing).map(([k, v]) => `${k}=${v}`);
  writeFileSync(file, `${lines.length ? `${lines.join('\n')}\n` : ''}`, { mode: 0o600 });
  return true;
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
  const name = typeof flags.env === 'string' ? flags.env : manifest.keyEnv;
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
      const tiers = (manifest.agents ?? []).filter((t) => modelFor(manifest, t).keyEnv === varName);
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
