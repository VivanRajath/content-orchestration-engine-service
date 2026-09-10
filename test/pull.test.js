import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planUpdate, writeLock, readLock, packFiles, LOCK } from '../src/pack.js';

/**
 * The merge is the only reason `pull` is not `rm -rf && install`. These tests
 * are about one question: when the pack and the user have both touched a file,
 * who wins? The answer has to be the user, every time, without --force.
 */

function tree(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jra-pull-')));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

/** Install `pack` into a fresh dest and record the lock, as init does. */
function installed(packFilesMap) {
  const packDir = tree(packFilesMap);
  const dest = tree(packFilesMap);
  writeLock(dest, { dir: packDir, url: 'https://x.test', sha: 'a'.repeat(40), name: 'p', version: '1' });
  rmSync(packDir, { recursive: true, force: true });
  return dest;
}

const V1 = {
  'SOUL.md': 'soul v1\n',
  'DUTIES.md': 'duties v1\n',
  'agents/junior-dev/RULES.md': 'junior v1\n',
  'agents/senior-dev/RULES.md': 'senior v1\n',
};

describe('planUpdate', () => {
  test('a file neither side touched is unchanged', () => {
    const dest = installed(V1);
    const next = { dir: tree(V1) };
    const plan = planUpdate(dest, next, readLock(dest));
    assert.deepEqual(plan.update, []);
    assert.deepEqual(plan.conflict, []);
    assert.equal(plan.unchanged.length, Object.keys(V1).length);
    rmSync(dest, { recursive: true, force: true });
    rmSync(next.dir, { recursive: true, force: true });
  });

  test('the pack changed it and you did not — it updates', () => {
    const dest = installed(V1);
    const next = { dir: tree({ ...V1, 'SOUL.md': 'soul v2\n' }) };
    const plan = planUpdate(dest, next, readLock(dest));
    assert.deepEqual(plan.update, ['SOUL.md']);
    assert.deepEqual(plan.conflict, []);
    rmSync(dest, { recursive: true, force: true });
    rmSync(next.dir, { recursive: true, force: true });
  });

  // The whole point of the tool is that these files are yours to edit.
  test('you changed it and the pack did too — yours is kept', () => {
    const dest = installed(V1);
    writeFileSync(join(dest, 'agents/junior-dev/RULES.md'), 'OUR TEAM EDIT\n');
    const next = { dir: tree({ ...V1, 'agents/junior-dev/RULES.md': 'junior v2\n' }) };
    const plan = planUpdate(dest, next, readLock(dest));
    assert.deepEqual(plan.conflict, ['agents/junior-dev/RULES.md']);
    assert.deepEqual(plan.update, []);
    rmSync(dest, { recursive: true, force: true });
    rmSync(next.dir, { recursive: true, force: true });
  });

  test('you changed it and the pack did not — it is left alone', () => {
    const dest = installed(V1);
    writeFileSync(join(dest, 'SOUL.md'), 'my soul\n');
    const next = { dir: tree(V1) };
    const plan = planUpdate(dest, next, readLock(dest));
    assert.deepEqual(plan.conflict, ['SOUL.md']);
    assert.deepEqual(plan.update, []);
    rmSync(dest, { recursive: true, force: true });
    rmSync(next.dir, { recursive: true, force: true });
  });

  test('a file the pack adds is created', () => {
    const dest = installed(V1);
    const next = { dir: tree({ ...V1, 'agents/reviewer/SOUL.md': 'new tier\n' }) };
    const plan = planUpdate(dest, next, readLock(dest));
    assert.deepEqual(plan.create, ['agents/reviewer/SOUL.md']);
    rmSync(dest, { recursive: true, force: true });
    rmSync(next.dir, { recursive: true, force: true });
  });

  test('a file the pack drops is removed when you never touched it', () => {
    const dest = installed(V1);
    const { 'DUTIES.md': _gone, ...rest } = V1;
    const next = { dir: tree(rest) };
    const plan = planUpdate(dest, next, readLock(dest));
    assert.deepEqual(plan.remove, ['DUTIES.md']);
    rmSync(dest, { recursive: true, force: true });
    rmSync(next.dir, { recursive: true, force: true });
  });

  // Deleting someone's edited file to honour an upstream removal is the worst
  // available reading of "update".
  test('a file the pack drops is kept when you edited it', () => {
    const dest = installed(V1);
    writeFileSync(join(dest, 'DUTIES.md'), 'our duties\n');
    const { 'DUTIES.md': _gone, ...rest } = V1;
    const next = { dir: tree(rest) };
    const plan = planUpdate(dest, next, readLock(dest));
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(plan.orphaned, ['DUTIES.md']);
    rmSync(dest, { recursive: true, force: true });
    rmSync(next.dir, { recursive: true, force: true });
  });

  test('a file you created yourself is in none of the lists', () => {
    const dest = installed(V1);
    writeFileSync(join(dest, 'agents/junior-dev/NOTES.md'), 'mine\n');
    const next = { dir: tree(V1) };
    const plan = planUpdate(dest, next, readLock(dest));
    for (const list of Object.values(plan)) {
      assert.ok(!list.includes('agents/junior-dev/NOTES.md'));
    }
    rmSync(dest, { recursive: true, force: true });
    rmSync(next.dir, { recursive: true, force: true });
  });

  // Without a lock there is no third point, so nothing can be proven
  // unmodified. Treating every difference as the user's is the safe direction.
  test('with no lock, every differing file is treated as yours', () => {
    const dest = tree(V1);
    const next = { dir: tree({ ...V1, 'SOUL.md': 'soul v2\n' }) };
    const plan = planUpdate(dest, next, null);
    assert.deepEqual(plan.conflict, ['SOUL.md']);
    assert.deepEqual(plan.update, []);
    rmSync(dest, { recursive: true, force: true });
    rmSync(next.dir, { recursive: true, force: true });
  });

  test('a file missing from disk is restored rather than reported as yours', () => {
    const dest = installed(V1);
    rmSync(join(dest, 'SOUL.md'));
    const next = { dir: tree(V1) };
    const plan = planUpdate(dest, next, readLock(dest));
    assert.deepEqual(plan.create, ['SOUL.md']);
    rmSync(dest, { recursive: true, force: true });
    rmSync(next.dir, { recursive: true, force: true });
  });
});

describe('the lock', () => {
  test('records every file the pack ships', () => {
    const dest = installed(V1);
    const lock = readLock(dest);
    assert.deepEqual(Object.keys(lock.files).sort(), Object.keys(V1).sort());
    assert.equal(lock.commit, 'a'.repeat(40));
    rmSync(dest, { recursive: true, force: true });
  });

  test('does not record itself', () => {
    const dest = installed(V1);
    assert.ok(!Object.keys(readLock(dest).files).includes(LOCK));
    rmSync(dest, { recursive: true, force: true });
  });

  test('a corrupt lock reads as absent rather than throwing', () => {
    const dest = installed(V1);
    writeFileSync(join(dest, LOCK), '{ not json');
    assert.equal(readLock(dest), null);
    rmSync(dest, { recursive: true, force: true });
  });

  // A changing field would put a spurious diff in the user's repo on every
  // pull, since .gitagent/ is committed.
  test('is byte-identical when nothing moved', () => {
    const packDir = tree(V1);
    const dest = tree(V1);
    const pack = { dir: packDir, url: 'https://x.test', sha: 'b'.repeat(40), name: 'p', version: '1' };
    writeLock(dest, pack);
    const first = readFileSync(join(dest, LOCK), 'utf8');
    writeLock(dest, pack);
    assert.equal(readFileSync(join(dest, LOCK), 'utf8'), first);
    rmSync(dest, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
  });
});

describe('packFiles', () => {
  test('walks nested directories and sorts', () => {
    const dir = tree(V1);
    assert.deepEqual(packFiles(dir), [
      'DUTIES.md',
      'SOUL.md',
      'agents/junior-dev/RULES.md',
      'agents/senior-dev/RULES.md',
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('skips the pack repo\'s own housekeeping, matching installPack', () => {
    const dir = tree({ ...V1, '.gitignore': 'x\n', '.gitattributes': 'y\n' });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref\n');
    const found = packFiles(dir);
    assert.ok(!found.some((f) => f.startsWith('.git')));
    rmSync(dir, { recursive: true, force: true });
  });
});
