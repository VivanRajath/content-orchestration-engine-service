import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './paths.js';
import { c, ok, info } from './util.js';

function manifestPath() {
  const p = join(agentDir(), 'agent.yaml');
  if (!existsSync(p)) throw new Error('No .gitagent/ found. Run `jr-architect init` first.');
  return p;
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
    const [, key] = path.split('.');
    if (!key) throw new Error(`Expected <section.key>, got "${path}"`);

    const p = manifestPath();
    const text = readFileSync(p, 'utf8');
    const re = new RegExp(`^(\\s*${key}:).*$`, 'm');
    if (!re.test(text)) throw new Error(`Key "${key}" not found in agent.yaml`);
    writeFileSync(p, text.replace(re, `$1 ${value}`));
    ok(`${path} = ${value}`);
    return;
  }

  throw new Error(`Unknown config action "${action}". Use show or set.`);
}
