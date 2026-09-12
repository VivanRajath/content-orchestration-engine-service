import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { personas } from '../src/personas.js';
import { readAgents } from '../src/agents.js';
import { readManifest } from '../src/config.js';
import { TEMPLATES } from '../src/paths.js';

/**
 * Adding and removing agents.
 *
 * The directory is the only thing that installs an agent. There is no manifest
 * list and no DUTIES table to keep in step — those were a second source of
 * truth, and two sources drift.
 */
async function inRepo(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jra-personas-')));
  mkdirSync(join(root, '.git'));
  cpSync(TEMPLATES, join(root, '.gitagent'), { recursive: true });
  const prev = process.cwd();
  process.chdir(root);
  try {
    return await fn(root);
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
}

const names = () => readAgents().map((a) => a.name);
const agentDirOf = (root, name) => join(root, '.gitagent', 'agents', name);

describe('personas add', () => {
  test('creating the folder is what installs the agent', async () => {
    await inRepo(async (root) => {
      await personas(['add', 'reviewer'], {});
      assert.ok(existsSync(join(agentDirOf(root, 'reviewer'), 'SOUL.md')));
      assert.ok(names().includes('reviewer'));
    });
  });

  // The list in agent.yaml was removed; readAgents reads the directory.
  test('the manifest is not touched', async () => {
    await inRepo(async (root) => {
      const file = join(root, '.gitagent', 'agent.yaml');
      const before = readFileSync(file, 'utf8');
      await personas(['add', 'reviewer'], {});
      assert.equal(readFileSync(file, 'utf8'), before);
      assert.deepEqual(readManifest(file).agents, []);
    });
  });

  test('DUTIES.md is not touched', async () => {
    await inRepo(async (root) => {
      const file = join(root, '.gitagent', 'DUTIES.md');
      const before = readFileSync(file, 'utf8');
      await personas(['add', 'reviewer'], {});
      assert.equal(readFileSync(file, 'utf8'), before);
    });
  });

  test('the blank agent declares the fields the loop reads', async () => {
    await inRepo(async () => {
      await personas(['add', 'reviewer'], {});
      const [made] = readAgents().filter((a) => a.name === 'reviewer');
      assert.equal(made.priority, 50);
      assert.equal(made.parallel, false);
      assert.deepEqual(made.owns, []);
      assert.equal(made.terminal, false);
    });
  });

  test('an existing agent is not clobbered without --force', async () => {
    await inRepo(async () => {
      await assert.rejects(() => personas(['add', 'junior-dev'], {}), /already exists/);
    });
  });
});

describe('personas remove', () => {
  test('deleting the folder uninstalls the agent', async () => {
    await inRepo(async (root) => {
      await personas(['add', 'reviewer'], {});
      await personas(['remove', 'reviewer'], {});
      assert.ok(!existsSync(agentDirOf(root, 'reviewer')));
      assert.ok(!names().includes('reviewer'));
    });
  });

  test('a full add/remove round trip leaves the scaffold as it was', async () => {
    await inRepo(async (root) => {
      const manifest = join(root, '.gitagent', 'agent.yaml');
      const duties = join(root, '.gitagent', 'DUTIES.md');
      const before = [readFileSync(manifest, 'utf8'), readFileSync(duties, 'utf8'), names()];

      await personas(['add', 'reviewer'], {});
      await personas(['remove', 'reviewer'], {});

      assert.equal(readFileSync(manifest, 'utf8'), before[0]);
      assert.equal(readFileSync(duties, 'utf8'), before[1]);
      assert.deepEqual(names(), before[2]);
    });
  });

  // Zero agents is a real state the loop refuses to run in, not something to
  // paper over by pretending the defaults are still there.
  test('every agent can be removed, leaving none', async () => {
    await inRepo(async () => {
      for (const name of names()) await personas(['remove', name], {});
      assert.deepEqual(names(), []);
    });
  });

  test('removing something absent is an error, not a silent pass', async () => {
    await inRepo(async () => {
      await assert.rejects(() => personas(['remove', 'ghost'], {}), /No persona/);
    });
  });
});
