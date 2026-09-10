import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { personas } from '../src/personas.js';
import { readManifest } from '../src/config.js';
import { TEMPLATES } from '../src/paths.js';

/**
 * A persona directory on its own does nothing: agent.yaml decides which tiers
 * exist, and DUTIES.md is the contract the loop reads back to the model. These
 * tests are about the wiring, not the files.
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

const manifestOf = (root) => readManifest(join(root, '.gitagent', 'agent.yaml'));
const dutiesOf = (root) => readFileSync(join(root, '.gitagent', 'DUTIES.md'), 'utf8');
const tierRows = (text) => text.split('\n').filter((l) => /^\| `/.test(l));

describe('personas add', () => {
  test('adds the tier to agent.yaml', async () => {
    await inRepo(async (root) => {
      await personas(['add', 'reviewer'], {});
      assert.ok(manifestOf(root).agents.includes('reviewer'));
    });
  });

  test('adds a row to the DUTIES.md tier table', async () => {
    await inRepo(async (root) => {
      await personas(['add', 'reviewer'], {});
      const rows = tierRows(dutiesOf(root));
      assert.equal(rows.length, 5);
      assert.match(rows.at(-1), /^\| `reviewer` \|/);
    });
  });

  // The tier name also appears in the escalation prose below the table. A
  // file-wide replace would rewrite the sentences defining the handoff graph.
  test('leaves the escalation prose untouched', async () => {
    await inRepo(async (root) => {
      const before = dutiesOf(root);
      await personas(['add', 'reviewer'], {});
      const after = dutiesOf(root);
      for (const line of before.split('\n').filter((l) => l.startsWith('- **'))) {
        assert.ok(after.includes(line), `escalation rule was altered: ${line}`);
      }
    });
  });

  test('adding twice does not duplicate the entry', async () => {
    await inRepo(async (root) => {
      await personas(['add', 'reviewer'], {});
      await personas(['add', 'reviewer'], { force: true });
      const agents = manifestOf(root).agents.filter((a) => a === 'reviewer');
      assert.equal(agents.length, 1);
      assert.equal(tierRows(dutiesOf(root)).filter((r) => r.includes('reviewer')).length, 1);
    });
  });
});

describe('personas remove', () => {
  test('removes from both files', async () => {
    await inRepo(async (root) => {
      await personas(['add', 'reviewer'], {});
      await personas(['remove', 'reviewer'], {});
      assert.ok(!manifestOf(root).agents.includes('reviewer'));
      assert.equal(tierRows(dutiesOf(root)).length, 4);
    });
  });

  test('a full add/remove round trip restores the tier table', async () => {
    await inRepo(async (root) => {
      const before = dutiesOf(root);
      await personas(['add', 'reviewer'], {});
      await personas(['remove', 'reviewer'], {});
      assert.equal(dutiesOf(root), before);
    });
  });

  // An agents list with nothing in it would leave the classifier no tier to
  // route to at all.
  test('refuses to empty the agents list', async () => {
    await inRepo(async (root) => {
      for (const t of ['build-doctor', 'senior-dev', 'junior-dev', 'ui-editor']) {
        await personas(['remove', t], {});
      }
      assert.ok(manifestOf(root).agents.length >= 1, 'agent.yaml was left with no agents');
    });
  });
});
