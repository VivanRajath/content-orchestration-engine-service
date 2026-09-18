import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, loadEnv, writeKey, removeKey, ensureIgnored, fingerprint, ENV_FILE } from '../src/env.js';
import { loadHooks, checkRead } from '../src/hooks.js';
import { TEMPLATES } from '../src/paths.js';

/**
 * The key is the one secret this tool touches, so these tests are about the
 * three properties that keep it safe: git never sees it, the agent never reads
 * it, and a deliberately exported shell variable always wins over a file
 * somebody set up weeks ago.
 */

const VAR = 'JRA_TEST_KEY_VAR';
const OTHER = 'JRA_TEST_OTHER_VAR';

afterEach(() => {
  delete process.env[VAR];
  delete process.env[OTHER];
});

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jra-env-')));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, '.gitagent'), { recursive: true });
  return root;
}

const clean = (d) => rmSync(d, { recursive: true, force: true });

describe('parseEnv', () => {
  test('reads KEY=value', () => {
    assert.deepEqual(parseEnv('A=1\nB=two\n'), { A: '1', B: 'two' });
  });

  test('ignores comments and blank lines', () => {
    assert.deepEqual(parseEnv('# note\n\nA=1\n'), { A: '1' });
  });

  // A key pasted out of a shell command often arrives wearing quotes, and the
  // resulting 401 is impossible to diagnose from the error alone.
  test('strips surrounding quotes', () => {
    assert.deepEqual(parseEnv('A="sk-1"\nB=\'sk-2\'\n'), { A: 'sk-1', B: 'sk-2' });
  });

  test('keeps = inside a value', () => {
    assert.deepEqual(parseEnv('A=a=b=c\n'), { A: 'a=b=c' });
  });

  test('skips lines that are not assignments', () => {
    assert.deepEqual(parseEnv('nonsense\n=novalue\nA=1\n'), { A: '1' });
  });
});

describe('loadEnv', () => {
  test('fills a variable the shell left unset', () => {
    const root = sandbox();
    writeFileSync(join(root, '.gitagent', ENV_FILE), `${VAR}=from-file\n`);
    loadEnv(join(root, '.gitagent'));
    assert.equal(process.env[VAR], 'from-file');
    clean(root);
  });

  // A variable exported deliberately for this command must not be silently
  // overridden by a file. This is the rule that makes the file safe to keep.
  test('never overrides what the shell already set', () => {
    const root = sandbox();
    process.env[VAR] = 'from-shell';
    writeFileSync(join(root, '.gitagent', ENV_FILE), `${VAR}=from-file\n`);
    loadEnv(join(root, '.gitagent'));
    assert.equal(process.env[VAR], 'from-shell');
    clean(root);
  });

  test('treats an empty shell value as unset', () => {
    const root = sandbox();
    process.env[VAR] = '';
    writeFileSync(join(root, '.gitagent', ENV_FILE), `${VAR}=from-file\n`);
    loadEnv(join(root, '.gitagent'));
    assert.equal(process.env[VAR], 'from-file');
    clean(root);
  });

  test('a missing file is not an error', () => {
    const root = sandbox();
    assert.deepEqual(loadEnv(join(root, '.gitagent')), []);
    clean(root);
  });
});

describe('writeKey', () => {
  test('writes the value and reads back', () => {
    const root = sandbox();
    const dir = join(root, '.gitagent');
    writeKey(VAR, 'sk-secret-value', dir);
    assert.match(readFileSync(join(dir, ENV_FILE), 'utf8'), /sk-secret-value/);
    loadEnv(dir);
    assert.equal(process.env[VAR], 'sk-secret-value');
    clean(root);
  });

  test('keeps keys for other providers when adding one', () => {
    const root = sandbox();
    const dir = join(root, '.gitagent');
    writeKey(VAR, 'one', dir);
    writeKey(OTHER, 'two', dir);
    const parsed = parseEnv(readFileSync(join(dir, ENV_FILE), 'utf8'));
    assert.equal(parsed[VAR], 'one');
    assert.equal(parsed[OTHER], 'two');
    clean(root);
  });

  test('replaces rather than appends on rewrite', () => {
    const root = sandbox();
    const dir = join(root, '.gitagent');
    writeKey(VAR, 'first', dir);
    writeKey(VAR, 'second', dir);
    const text = readFileSync(join(dir, ENV_FILE), 'utf8');
    assert.ok(!text.includes('first'));
    assert.equal(parseEnv(text)[VAR], 'second');
    clean(root);
  });

  test('removeKey drops one and leaves the rest', () => {
    const root = sandbox();
    const dir = join(root, '.gitagent');
    writeKey(VAR, 'one', dir);
    writeKey(OTHER, 'two', dir);
    assert.equal(removeKey(VAR, dir), true);
    const parsed = parseEnv(readFileSync(join(dir, ENV_FILE), 'utf8'));
    assert.ok(!(VAR in parsed));
    assert.equal(parsed[OTHER], 'two');
    clean(root);
  });

  test('removing something absent reports false rather than throwing', () => {
    const root = sandbox();
    assert.equal(removeKey(VAR, join(root, '.gitagent')), false);
    clean(root);
  });
});

describe('ensureIgnored', () => {
  // Writing a key to disk is only acceptable while the file is genuinely
  // ignored, so the rule is verified before the write, never after.
  test('adds the rule when .gitignore does not have it', () => {
    const root = sandbox();
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    assert.equal(ensureIgnored(root), false);
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /\.gitagent\/\.env/);
    clean(root);
  });

  test('reports true and changes nothing when already covered', () => {
    const root = sandbox();
    writeFileSync(join(root, '.gitignore'), '.gitagent/.env\n');
    const before = readFileSync(join(root, '.gitignore'), 'utf8');
    assert.equal(ensureIgnored(root), true);
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), before);
    clean(root);
  });

  test('creates .gitignore when there is none', () => {
    const root = sandbox();
    ensureIgnored(root);
    assert.ok(existsSync(join(root, '.gitignore')));
    clean(root);
  });
});

describe('the agent cannot read the key it uses', () => {
  // .env* is a SEALED protected-read path, so this holds even if the user
  // empties hooks.yaml entirely.
  test('every path shape for the key file is blocked', () => {
    const root = sandbox();
    const hooks = loadHooks(join(root, '.gitagent'), { reload: true });
    for (const p of ['.gitagent/.env', '.env', 'packages/app/.env.local']) {
      assert.equal(checkRead(p, 'senior-dev', hooks).allowed, false, `${p} was readable`);
    }
    clean(root);
  });
});

describe('fingerprint', () => {
  test('shows four characters and a length, never the key', () => {
    const out = fingerprint('sk-ant-api03-abcdefghijklmnop');
    assert.match(out, /^sk-a…/);
    assert.match(out, /29 chars/);
    assert.ok(!out.includes('abcdefghijklmnop'));
  });

  test('an empty value has no fingerprint', () => {
    assert.equal(fingerprint(''), '');
  });
});

describe('the key file, edited by hand', () => {
  test('it exists from setup, and says what to type', async () => {
    const { ensureEnvFile } = await import('../src/env.js');
    const root = sandbox();
    try {
      assert.equal(ensureEnvFile(join(root, '.gitagent'), root), true);
      const text = readFileSync(join(root, '.gitagent', ENV_FILE), 'utf8');
      assert.match(text, /NAME=value/, 'it explains the format');
      assert.match(text, /^# GROQ_API_KEY=$/m, 'with a placeholder per provider');
      assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /\.gitagent\/\.env/, 'ignored before it existed');
      assert.equal(ensureEnvFile(join(root, '.gitagent'), root), false, 'and never overwritten once there');
    } finally { clean(root); }
  });

  test('saving a key edits its own line and keeps everything a person wrote', async () => {
    const root = sandbox();
    try {
      const dir = join(root, '.gitagent');
      writeFileSync(join(dir, ENV_FILE), '# my notes: the work key is below\n# GROQ_API_KEY=\nOTHER_THING=keep\n');
      writeKey('GROQ_API_KEY', 'gsk_first', dir);
      writeKey('GROQ_API_KEY', 'gsk_second', dir);

      const text = readFileSync(join(dir, ENV_FILE), 'utf8');
      assert.match(text, /# my notes: the work key is below/, 'comments survive');
      assert.match(text, /^OTHER_THING=keep$/m, 'so do other lines');
      assert.equal((text.match(/^GROQ_API_KEY=/gm) || []).length, 1, 'one line for the key, replaced in place');
      assert.match(text, /^GROQ_API_KEY=gsk_second$/m);
      assert.doesNotMatch(text, /# GROQ_API_KEY=/, 'the placeholder became the real line');

      removeKey('GROQ_API_KEY', dir);
      assert.match(readFileSync(join(dir, ENV_FILE), 'utf8'), /# my notes/, 'and removing one keeps the rest');
    } finally { clean(root); }
  });

  test('what a person types by hand is read: export, spaces, CRLF, a byte-order mark', () => {
    assert.deepEqual(
      parseEnv('﻿export GROQ_API_KEY = gsk_abc\r\nXAI_API_KEY=xai-def\r\n'),
      { GROQ_API_KEY: 'gsk_abc', XAI_API_KEY: 'xai-def' },
    );
  });
});

describe('picking up an edited key file while running', () => {
  test('a new line is used, a changed one updated, a deleted one forgotten', async () => {
    const { reloadEnv } = await import('../src/env.js');
    const root = sandbox();
    try {
      const dir = join(root, '.gitagent');
      writeFileSync(join(dir, ENV_FILE), `${VAR}=first\n`);
      loadEnv(dir);
      assert.equal(process.env[VAR], 'first');

      writeFileSync(join(dir, ENV_FILE), `${VAR}=second\n${OTHER}=added\n`);
      const changed = reloadEnv(dir);
      assert.equal(process.env[VAR], 'second', 'an edited key is picked up');
      assert.equal(process.env[OTHER], 'added', 'and a new one');
      assert.deepEqual(changed.sort(), [OTHER, VAR].sort(), 'and the chat can say which');

      writeFileSync(join(dir, ENV_FILE), `${OTHER}=added\n`);
      reloadEnv(dir);
      assert.equal(process.env[VAR], undefined, 'a deleted line is forgotten');
    } finally { clean(root); }
  });

  test('a key exported in the shell is never overridden by the file', async () => {
    const { reloadEnv } = await import('../src/env.js');
    const root = sandbox();
    try {
      const dir = join(root, '.gitagent');
      process.env[VAR] = 'from-the-shell';
      writeFileSync(join(dir, ENV_FILE), `${VAR}=from-the-file\n`);
      loadEnv(dir);
      reloadEnv(dir);
      assert.equal(process.env[VAR], 'from-the-shell');
    } finally { clean(root); }
  });
});

describe('keys found in the file', () => {
  function withManifest() {
    const root = sandbox();
    const dir = join(root, '.gitagent');
    const manifest = readFileSync(join(TEMPLATES, 'agent.yaml'), 'utf8')
      .replace('provider: anthropic', 'provider: groq').replace('ANTHROPIC_API_KEY', 'GROQ_API_KEY');
    writeFileSync(join(dir, 'agent.yaml'), manifest);
    return { root, dir };
  }

  test('a key under a new name is recorded, so it is offered in /models and /prompt', async () => {
    const { discoverKeys } = await import('../src/env.js');
    const { readManifest } = await import('../src/config.js');
    const { root, dir } = withManifest();
    try {
      writeFileSync(join(dir, ENV_FILE), [
        'GROQ_API_KEY=gsk_default',
        'GROQ_API_KEY_5=gsk_fifth',
        'MY_CLAUDE=sk-ant-api03-by-its-value',
        'LLM_API_KEY=needs-a-base-url',
      ].join('\n'));

      const found = discoverKeys(dir);
      assert.deepEqual(found.map((f) => [f.name, f.provider]), [
        ['GROQ_API_KEY_5', 'groq'],
        ['MY_CLAUDE', 'anthropic'],
      ], 'by name, then by value; the default is already known, and a keyless URL is not guessed');
      assert.ok(readManifest(join(dir, 'agent.yaml')).keys.some((k) => k.keyEnv === 'MY_CLAUDE'));
      assert.deepEqual(discoverKeys(dir), [], 'and found once, not every message');
    } finally { clean(root); }
  });

  test('a key pasted into agent.yaml is moved out of the committed file', async () => {
    const { misplacedKeys, moveMisplacedKey } = await import('../src/env.js');
    const { readManifest } = await import('../src/config.js');
    const { root, dir } = withManifest();
    try {
      const file = join(dir, 'agent.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace('api_key_env: GROQ_API_KEY', 'api_key_env: gsk_pasted_right_here_123'));

      const found = misplacedKeys(readManifest(file));
      assert.equal(found.length, 1);
      const name = moveMisplacedKey(found[0], dir, root);

      assert.equal(name, 'GROQ_API_KEY');
      assert.doesNotMatch(readFileSync(file, 'utf8'), /gsk_pasted/, 'the key is gone from agent.yaml');
      assert.equal(readManifest(file).keyEnv, 'GROQ_API_KEY', 'which names its variable again');
      assert.equal(parseEnv(readFileSync(join(dir, ENV_FILE), 'utf8')).GROQ_API_KEY, 'gsk_pasted_right_here_123');
      delete process.env.GROQ_API_KEY;
    } finally { clean(root); }
  });
});
