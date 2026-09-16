import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect, verify, tail, winCmd, resolveBin } from '../src/verify.js';

function repo(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jra-verify-')));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const pkg = (scripts) => JSON.stringify({ name: 'x', scripts }, null, 2);

describe('detect', () => {
  test('prefers test over build — a green build with red tests is not green', () => {
    const dir = repo({ 'package.json': pkg({ build: 'tsc', test: 'node --test' }) });
    assert.deepEqual(detect(dir).argv, ['npm', 'run', 'test']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('falls through to build when there is no test script', () => {
    const dir = repo({ 'package.json': pkg({ build: 'tsc' }) });
    assert.deepEqual(detect(dir).argv, ['npm', 'run', 'build']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('an empty script value does not count as a command', () => {
    const dir = repo({ 'package.json': pkg({ test: '   ', build: 'tsc' }) });
    assert.deepEqual(detect(dir).argv, ['npm', 'run', 'build']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('the lockfile picks the client', () => {
    const dir = repo({ 'package.json': pkg({ test: 'x' }), 'pnpm-lock.yaml': '' });
    assert.equal(detect(dir).argv[0], 'pnpm');
    rmSync(dir, { recursive: true, force: true });
  });

  test('unparseable package.json falls through instead of throwing', () => {
    const dir = repo({ 'package.json': '{ broken', 'Cargo.toml': '' });
    assert.deepEqual(detect(dir).argv, ['cargo', 'test', '--quiet']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a repo with nothing recognisable returns null', () => {
    const dir = repo({ 'README.md': 'hi' });
    assert.equal(detect(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('verify — three states, not two', () => {
  // "We did not check" and "it passed" must never collapse into one value:
  // checkCommit warns on null, and classify() does not route to build-doctor.
  test('no command found is null, not false', () => {
    const dir = repo({ 'README.md': 'hi' });
    const r = verify({ root: dir });
    assert.equal(r.green, null);
    assert.match(r.reason, /no build or test command/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a passing command is green', () => {
    const dir = repo({});
    const r = verify({ root: dir, command: { argv: [process.execPath, '-e', 'process.exit(0)'], label: 'ok' } });
    assert.equal(r.green, true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a failing command is red and keeps the output', () => {
    const dir = repo({});
    const r = verify({
      root: dir,
      command: { argv: [process.execPath, '-e', 'console.error("assertion failed"); process.exit(1)'], label: 'x' },
    });
    assert.equal(r.green, false);
    assert.match(r.output, /assertion failed/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a missing binary is unknown, not red', () => {
    const dir = repo({});
    const r = verify({ root: dir, command: { argv: ['definitely-not-a-real-binary-xyz'], label: 'x' } });
    assert.equal(r.green, null);
    rmSync(dir, { recursive: true, force: true });
  });

  // A timeout reported as red sends build-doctor after a bug that is not there.
  test('a timeout is unknown, not red', () => {
    const dir = repo({});
    const r = verify({
      root: dir,
      timeout: 300,
      command: { argv: [process.execPath, '-e', 'setTimeout(()=>{}, 10000)'], label: 'slow' },
    });
    assert.equal(r.green, null);
    assert.match(r.reason, /timed out/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('tail', () => {
  test('short text is untouched', () => {
    assert.equal(tail('hello'), 'hello');
  });

  // The failing assertion is near the end; the command that produced it is at
  // the start. Keeping one end routinely loses the actual cause.
  test('keeps both ends of a long log', () => {
    const text = `FIRST${'x'.repeat(9000)}LAST`;
    const out = tail(text, 1000);
    assert.match(out, /^FIRST/);
    assert.match(out, /LAST$/);
    assert.match(out, /characters omitted/);
    assert.ok(out.length < 1200);
  });
});

describe('winCmd — the Windows .cmd shim path', () => {
  test('builds a cmd.exe argv for a plain command', () => {
    const { args } = winCmd('npm.cmd', ['run', 'test']);
    assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(args[3], 'npm.cmd run test');
  });

  // shell:true would concatenate these into a command line, which is exactly
  // the metacharacter surface shell:false exists to remove.
  for (const bad of ['a&b', 'a|b', 'a>b', 'a b', 'a^b', 'a%PATH%b', 'a"b']) {
    test(`refuses a token containing ${JSON.stringify(bad)}`, () => {
      assert.throws(() => winCmd('npm.cmd', [bad]), /metacharacters/);
    });
  }

  test('leaves non-Windows platforms alone', () => {
    assert.deepEqual(resolveBin('npm', ['run', 'test'], 'linux'), { bin: 'npm', args: ['run', 'test'] });
  });

  test('leaves a non-shimmed binary alone even on Windows', () => {
    assert.deepEqual(resolveBin('git', ['status'], 'win32'), { bin: 'git', args: ['status'] });
  });
});

test('a command that prints a lot is not mistaken for a timeout', () => {
  // execFileSync kills at its buffer limit and reports SIGTERM, which reads as
  // a timeout. A verbose but passing suite was coming back "unknown", so the
  // build gate stopped gating.
  const root = mkdtempSync(join(tmpdir(), 'jra-verbose-'));
  try {
    const noisy = 'for (let i = 0; i < 60000; i++) console.log("line " + i + " of an ordinary test log");';
    const result = verify({
      root,
      command: { argv: [process.execPath, '-e', noisy], label: 'noisy build' },
    });

    assert.equal(result.green, true, 'exit 0 is a pass however much it printed');
    assert.equal(result.reason, undefined);
    assert.ok(result.output.length < 20000, 'and the output is still trimmed for the model');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
