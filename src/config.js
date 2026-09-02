import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './paths.js';
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

/** Minimal reader for the flat keys we expose. Not a general YAML parser. */
export function readManifest() {
  const text = readFileSync(manifestPath(), 'utf8');
  const get = (section, key) => {
    const re = new RegExp(`^${section}:[\\s\\S]*?^\\s+${key}:\\s*(.+)$`, 'm');
    const m = text.match(re);
    if (!m) return null;
    const v = m[1].trim().replace(/\s+#.*$/, '');
    return v === 'null' || v === '' ? null : v;
  };
  return {
    provider: get('model', 'provider'),
    model:    get('model', 'name'),
    keyEnv:   get('model', 'api_key_env'),
    baseUrl:  get('model', 'base_url'),
    entry:    get('routing', 'entry'),
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
