import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchSection, config } from '../src/config.js';
import { init } from '../src/init.js';
import { TEMPLATES } from '../src/paths.js';

const MANIFEST = readFileSync(join(TEMPLATES, 'agent.yaml'), 'utf8');

/**
 * Independent section-scoped reader, written the long way on purpose: if this
 * shared patchSection's own regexes, a bug in one would hide the other.
 */
function sectionValue(text, section, key) {
  const lines = text.split('\n');
  const head = lines.findIndex((l) => l.startsWith(`${section}:`));
  if (head === -1) return null;
  for (let i = head + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (!/^[ \t]/.test(line)) break;
    const m = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

/**
 * Run fn with a throwaway repo as cwd. repoRoot() walks up to .git, so the
 * marker directory is what keeps the scaffold inside the sandbox.
 *
 * Must be async and must await fn: a sync try/finally around an async fn
 * restores cwd and deletes the sandbox before the body has run, and init()
 * then scaffolds into the real project.
 */
async function inTempRepo(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jra-test-')));
  mkdirSync(join(dir, '.git'));
  const cwd = process.cwd();
  const log = console.log;
  process.chdir(dir);
  console.log = () => {};
  try {
    assert.equal(realpathSync(process.cwd()), dir, 'sandbox cwd not active');
    return await fn(dir);
  } finally {
    console.log = log;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('patchSection', () => {
  test('model.name leaves metadata.name untouched', () => {
    // The bug this whole helper exists to prevent: `name:` lives under both
    // metadata: and model:, and metadata: comes first in the file.
    const out = patchSection(MANIFEST, 'model', 'name', 'gpt-4o');
    assert.equal(sectionValue(out, 'model', 'name'), 'gpt-4o');
    assert.equal(sectionValue(out, 'metadata', 'name'), 'jr-architect');
  });

  test('metadata.name leaves model.name untouched', () => {
    const out = patchSection(MANIFEST, 'metadata', 'name', 'renamed');
    assert.equal(sectionValue(out, 'metadata', 'name'), 'renamed');
    assert.equal(sectionValue(out, 'model', 'name'), 'claude-sonnet-4-6');
  });

  test('patches a section that is not the first match in the file', () => {
    const out = patchSection(MANIFEST, 'routing', 'entry', 'senior-dev');
    assert.equal(sectionValue(out, 'routing', 'entry'), 'senior-dev');
  });

  test('only the target line changes', () => {
    const before = MANIFEST.split('\n');
    const after = patchSection(MANIFEST, 'model', 'provider', 'openai').split('\n');
    assert.equal(before.length, after.length);
    const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
    assert.deepEqual(changed.length, 1);
    assert.match(after[changed[0]], /^\s+provider: openai$/);
  });

  test('a value containing $& or $1 is written literally', () => {
    // Assignment, not String.replace — replace would expand these.
    const out = patchSection(MANIFEST, 'model', 'name', 'weird-$&-$1-model');
    assert.equal(sectionValue(out, 'model', 'name'), 'weird-$&-$1-model');
  });

  test('throws on an unknown section', () => {
    assert.throws(() => patchSection(MANIFEST, 'nope', 'name', 'x'), /Section "nope:" not found/);
  });

  test('throws on a key outside the named section', () => {
    // `description` exists under metadata:, but not under model:.
    assert.throws(() => patchSection(MANIFEST, 'model', 'description', 'x'), /Key "model\.description" not found/);
  });

  test('does not reach past a dedent into the next section', () => {
    assert.throws(() => patchSection(MANIFEST, 'memory', 'entry', 'x'), /Key "memory\.entry" not found/);
  });
});

describe('config set', () => {
  test('config set model.name leaves metadata.name untouched', async () => {
    await inTempRepo(async (dir) => {
      await init({ provider: 'anthropic' });
      await config(['set', 'model.name', 'gpt-4o'], {});
      const out = readFileSync(join(dir, '.gitagent', 'agent.yaml'), 'utf8');
      assert.equal(sectionValue(out, 'model', 'name'), 'gpt-4o');
      assert.equal(sectionValue(out, 'metadata', 'name'), 'jr-architect');
    });
  });

  test('config set routing.entry works', async () => {
    await inTempRepo(async (dir) => {
      await init({ provider: 'anthropic' });
      await config(['set', 'routing.entry', 'senior-dev'], {});
      const out = readFileSync(join(dir, '.gitagent', 'agent.yaml'), 'utf8');
      assert.equal(sectionValue(out, 'routing', 'entry'), 'senior-dev');
    });
  });

  test('rejects a bare key with no section', async () => {
    await inTempRepo(async () => {
      await init({ provider: 'anthropic' });
      await assert.rejects(() => config(['set', 'name', 'x'], {}), /Expected <section\.key>/);
    });
  });
});

describe('init', () => {
  test('patches the model block and nothing else', async () => {
    await inTempRepo(async (dir) => {
      await init({ provider: 'ollama', model: 'qwen2.5-coder:14b' });
      const out = readFileSync(join(dir, '.gitagent', 'agent.yaml'), 'utf8');
      assert.equal(sectionValue(out, 'model', 'provider'), 'ollama');
      assert.equal(sectionValue(out, 'model', 'name'), 'qwen2.5-coder:14b');
      assert.equal(sectionValue(out, 'model', 'api_key_env'), 'OLLAMA_API_KEY');
      assert.equal(sectionValue(out, 'model', 'base_url'), 'http://localhost:11434/v1');
      assert.equal(sectionValue(out, 'metadata', 'name'), 'jr-architect');
      assert.equal(sectionValue(out, 'metadata', 'version'), '0.1.0');
    });
  });

  test('writes base_url: null when the provider has none', async () => {
    await inTempRepo(async (dir) => {
      await init({ provider: 'anthropic' });
      const out = readFileSync(join(dir, '.gitagent', 'agent.yaml'), 'utf8');
      assert.equal(sectionValue(out, 'model', 'base_url'), 'null');
    });
  });

  test('gitignores the key file and session state', async () => {
    await inTempRepo(async (dir) => {
      await init({ provider: 'anthropic' });
      const ignored = readFileSync(join(dir, '.gitignore'), 'utf8');
      assert.match(ignored, /^\.gitagent\/\.env$/m);
      assert.match(ignored, /^\.gitagent\/\.session\/$/m);
    });
  });

  test('refuses to overwrite an existing .gitagent without --force', async () => {
    await inTempRepo(async () => {
      await init({ provider: 'anthropic' });
      await assert.rejects(() => init({ provider: 'anthropic' }), /already exists/);
    });
  });

  test('rejects an unknown provider', async () => {
    await inTempRepo(async () => {
      await assert.rejects(() => init({ provider: 'not-a-provider' }), /Unknown provider/);
    });
  });
});
