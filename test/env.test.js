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
