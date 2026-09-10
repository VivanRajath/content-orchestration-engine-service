import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from '../src/detect.js';

function repo(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jra-detect-')));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const pkg = (o) => JSON.stringify({ name: 'x', ...o }, null, 2);
const clean = (d) => rmSync(d, { recursive: true, force: true });

describe('stacks', () => {
  test('finds Node and its lockfile', () => {
    const dir = repo({ 'package.json': pkg({}), 'package-lock.json': '{}' });
    const [node] = inspect(dir).stacks;
    assert.equal(node.name, 'Node');
    assert.equal(node.lock, 'package-lock.json');
    clean(dir);
  });

  // A missing lockfile is DUTIES.md entry rule 1, not trivia: dependencies
  // that are not pinned route to build-doctor before anything else runs.
  test('reports a missing lockfile as lockable but absent', () => {
    const dir = repo({ 'package.json': pkg({}) });
    const [node] = inspect(dir).stacks;
    assert.equal(node.lock, null);
    assert.equal(node.lockable, true);
    clean(dir);
  });

  test('a polyglot repo reports every stack it finds', () => {
    const dir = repo({ 'package.json': pkg({}), 'Cargo.toml': '', 'go.mod': '' });
    const names = inspect(dir).stacks.map((s) => s.name);
    assert.deepEqual(names.sort(), ['Go', 'Node', 'Rust']);
    clean(dir);
  });

  test('an unrecognised repo reports nothing rather than guessing', () => {
    const dir = repo({ 'README.md': 'hi' });
    const found = inspect(dir);
    assert.deepEqual(found.stacks, []);
    assert.equal(found.verify, null);
    clean(dir);
  });
});

describe('frameworks', () => {
  test('reads dependencies and devDependencies', () => {
    const dir = repo({ 'package.json': pkg({ dependencies: { next: '14' }, devDependencies: { vitest: '1' } }) });
    const found = inspect(dir).frameworks;
    assert.ok(found.includes('Next.js'));
    assert.ok(found.includes('Vitest'));
    clean(dir);
  });

  test('deduplicates — react and @types/react are one fact', () => {
    const dir = repo({ 'package.json': pkg({ dependencies: { react: '18' }, devDependencies: { react: '18' } }) });
    assert.deepEqual(inspect(dir).frameworks.filter((f) => f === 'React').length, 1);
    clean(dir);
  });

  test('unparseable package.json yields no frameworks rather than throwing', () => {
    const dir = repo({ 'package.json': '{ broken' });
    assert.deepEqual(inspect(dir).frameworks, []);
    clean(dir);
  });
});

describe('monorepo', () => {
  test('npm workspaces', () => {
    const dir = repo({ 'package.json': pkg({ workspaces: ['packages/*'] }) });
    assert.equal(inspect(dir).monorepo.kind, 'npm workspaces');
    clean(dir);
  });

  test('the object form of workspaces', () => {
    const dir = repo({ 'package.json': pkg({ workspaces: { packages: ['apps/*'] } }) });
    assert.deepEqual(inspect(dir).monorepo.globs, ['apps/*']);
    clean(dir);
  });

  test('a packages/ directory of real packages', () => {
    const dir = repo({ 'package.json': pkg({}), 'packages/one/package.json': pkg({}) });
    assert.match(inspect(dir).monorepo.kind, /packages/);
    clean(dir);
  });

  test('a plain repo is not a monorepo', () => {
    const dir = repo({ 'package.json': pkg({}) });
    assert.equal(inspect(dir).monorepo, null);
    clean(dir);
  });
});

describe('ci and containers', () => {
  test('finds workflow and container files', () => {
    const dir = repo({ 'package.json': pkg({}), '.github/workflows/ci.yml': '', 'Dockerfile': '' });
    const found = inspect(dir);
    assert.ok(found.ci.includes('.github/workflows'));
    assert.ok(found.container.includes('Dockerfile'));
    clean(dir);
  });
});

describe('verify command', () => {
  // detect must agree with what the run loop will actually execute, or the
  // report is telling the user about a different repo than the agent sees.
  test('matches what verify.js would choose', () => {
    const dir = repo({ 'package.json': pkg({ scripts: { test: 'node --test' } }) });
    assert.deepEqual(inspect(dir).verify.argv, ['npm', 'run', 'test']);
    clean(dir);
  });
});
