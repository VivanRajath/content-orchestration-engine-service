import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frontMatter, readAgents, ownsPath, partition, swarmable, disjoint } from '../src/agents.js';

/**
 * Agents describe themselves. build-doctor, junior-dev, senior-dev and
 * ui-editor are a default pack, not the product, so nothing here may assume a
 * fixed set, a fixed count, or a fixed ladder.
 */
function repo(agents) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jra-agents-')));
  for (const [name, soul] of Object.entries(agents)) {
    mkdirSync(join(root, 'agents', name), { recursive: true });
    writeFileSync(join(root, 'agents', name, 'SOUL.md'), soul);
  }
  return root;
}
const clean = (d) => rmSync(d, { recursive: true, force: true });
const soul = (body) => `---\n${body}\n---\n\n# body text\n`;

describe('frontMatter', () => {
  test('splits metadata from the prose the model actually reads', () => {
    const { meta, body } = frontMatter(soul('name: x\nrole: does things'));
    assert.equal(meta.role, 'does things');
    assert.match(body, /body text/);
    assert.ok(!body.includes('role:'), 'front matter leaked into the prompt');
  });

  test('a file with no front matter is all body', () => {
    const { meta, body } = frontMatter('# just prose\n');
    assert.deepEqual(meta, {});
    assert.match(body, /just prose/);
  });

  // A broken header costs the agent its metadata, not its existence.
  test('malformed front matter does not throw', () => {
    const { meta } = frontMatter('---\n\tbad: indent\n---\nbody\n');
    assert.deepEqual(meta, {});
  });
});

describe('readAgents', () => {
  test('a directory with a SOUL.md is an installed agent', () => {
    const root = repo({ reviewer: soul('name: reviewer\nrole: reviews') });
    const found = readAgents(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].name, 'reviewer');
    assert.equal(found[0].role, 'reviews');
    clean(root);
  });

  test('a directory without SOUL.md is not an agent', () => {
    const root = repo({ real: soul('name: real') });
    mkdirSync(join(root, 'agents', 'notes'), { recursive: true });
    writeFileSync(join(root, 'agents', 'notes', 'README.md'), 'hi');
    assert.deepEqual(readAgents(root).map((a) => a.name), ['real']);
    clean(root);
  });

  // readdir order is not stable across machines, and an unstable order makes a
  // swarm unreproducible.
  test('orders by priority then name, deterministically', () => {
    const root = repo({
      zeta: soul('name: zeta\npriority: 10'),
      alpha: soul('name: alpha\npriority: 10'),
      first: soul('name: first\npriority: 0'),
    });
    assert.deepEqual(readAgents(root).map((a) => a.name), ['first', 'alpha', 'zeta']);
    clean(root);
  });

  test('an agent that declares nothing still loads with defaults', () => {
    const root = repo({ plain: '# no front matter at all\n' });
    const [a] = readAgents(root);
    assert.equal(a.name, 'plain');
    assert.equal(a.parallel, false);
    assert.deepEqual(a.owns, []);
    clean(root);
  });

  test('there is no fixed set — twelve agents is as valid as four', () => {
    const many = {};
    for (let i = 0; i < 12; i++) many[`agent-${i}`] = soul(`name: agent-${i}\npriority: ${i}`);
    const root = repo(many);
    assert.equal(readAgents(root).length, 12);
    clean(root);
  });

  test('an empty agents directory is empty, not a default four', () => {
    const root = repo({});
    assert.deepEqual(readAgents(root), []);
    clean(root);
  });
});

describe('scope', () => {
  test('an agent with no scope owns anything', () => {
    assert.equal(ownsPath({ owns: [] }, 'src/anything.js'), true);
  });

  test('a scoped agent owns only what it matches', () => {
    const a = { owns: ['**/*.css'] };
    assert.equal(ownsPath(a, 'src/app.css'), true);
    assert.equal(ownsPath(a, 'src/app.js'), false);
  });

  // A path going to two agents at once is how a swarm corrupts its own output.
  test('a path goes to exactly one agent, highest priority first', () => {
    const agents = [
      { name: 'css', priority: 1, owns: ['**/*.css'] },
      { name: 'all', priority: 9, owns: [] },
    ];
    const { claims } = partition(agents, ['a.css', 'b.js']);
    assert.deepEqual(claims.get('css'), ['a.css']);
    assert.deepEqual(claims.get('all'), ['b.js']);
  });

  test('paths nobody claims are reported, not silently dropped', () => {
    const { unclaimed } = partition([{ name: 'css', owns: ['**/*.css'] }], ['a.css', 'b.js']);
    assert.deepEqual(unclaimed, ['b.js']);
  });
});

describe('swarmable', () => {
  const agent = (name, owns, parallel = true) => ({ name, owns, parallel });

  test('disjoint scopes run together', () => {
    const groups = swarmable([agent('api', ['src/api/**']), agent('ui', ['src/ui/**'])]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map((a) => a.name), ['api', 'ui']);
  });

  test('overlapping scopes run separately', () => {
    const groups = swarmable([agent('api', ['src/api/**']), agent('all', ['src/**'])]);
    assert.equal(groups.length, 2);
  });

  // An agent that never opted in must not be run concurrently with anything.
  test('parallel:false always runs alone', () => {
    const groups = swarmable([agent('a', ['x/**'], false), agent('b', ['y/**'])]);
    assert.equal(groups.length, 2);
  });

  // No scope means it owns everything, so it overlaps with everyone.
  test('an unscoped agent runs alone even when it opted in', () => {
    const groups = swarmable([agent('any', []), agent('b', ['y/**'])]);
    assert.equal(groups[0].length, 1);
  });

  // Glob intersection is undecidable; being wrong toward "overlapping" costs
  // time, being wrong the other way costs the user's files.
  test('disjoint is conservative about what it cannot prove', () => {
    assert.equal(disjoint({ owns: ['src/**'] }, { owns: ['src/api/**'] }), false);
    assert.equal(disjoint({ owns: ['a/**'] }, { owns: ['b/**'] }), true);
    assert.equal(disjoint({ owns: ['**/*.css'] }, { owns: ['**/*.js'] }), false);
  });
});
