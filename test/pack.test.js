import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPack, confine, inspectHooks, installPack } from '../src/pack.js';
import { patchSequence, upsertSection } from '../src/config.js';

/**
 * Packs are built on disk rather than cloned. fetchPack's own job is `git
 * clone`, which is git's to get right; everything that decides whether a pack
 * is safe to install happens after the clone, on a directory.
 */
function buildPack(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jra-pack-test-')));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const MANIFEST = `apiVersion: gitagent/v1
kind: AgentPack
metadata:
  name: test-pack
  version: 1.2.3
agents:
  - name: junior-dev
    tier: 1
    role: Scoped work
    path: agents/junior-dev
  - name: senior-dev
    tier: 2
    role: Architectural work
    path: agents/senior-dev
hooks: hooks/hooks.yaml
routing:
  entry: auto
  diff_line_ceiling: 200
`;

const VALID = {
  'gitagent.yaml': MANIFEST,
  'SOUL.md': '# soul\n',
  'RULES.md': '# rules\n',
  'DUTIES.md': '# duties\n',
  'agents/junior-dev/SOUL.md': '# junior\n',
  'agents/junior-dev/RULES.md': '# junior rules\n',
  'agents/senior-dev/SOUL.md': '# senior\n',
  'agents/senior-dev/RULES.md': '# senior rules\n',
  'hooks/hooks.yaml': 'pre_edit:\n  - name: diff-ceiling\n    severity: warn\n',
};

describe('readPack', () => {
  test('reads tiers, identity, and routing', () => {
    const dir = buildPack(VALID);
    const pack = readPack(dir, { url: 'https://example.test/p', sha: 'abc123' });
    assert.equal(pack.name, 'test-pack');
    assert.equal(pack.version, '1.2.3');
    assert.deepEqual(pack.agents.map((a) => a.name), ['junior-dev', 'senior-dev']);
    assert.equal(pack.routing.diff_line_ceiling, 200);
    assert.equal(pack.identity.duties, 'DUTIES.md');
    assert.equal(pack.sha, 'abc123');
    rmSync(dir, { recursive: true, force: true });
  });

  test('a repo with no gitagent.yaml is not a pack', () => {
    const dir = buildPack({ 'README.md': 'hi\n' });
    assert.throws(() => readPack(dir), /not an agent pack/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a declared tier with no SOUL.md is refused', () => {
    const dir = buildPack(VALID);
    rmSync(join(dir, 'agents/senior-dev/SOUL.md'));
    assert.throws(() => readPack(dir), /senior-dev.*no SOUL\.md/s);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a tier with no RULES.md installs, but says so', () => {
    const dir = buildPack(VALID);
    rmSync(join(dir, 'agents/senior-dev/RULES.md'));
    const pack = readPack(dir);
    assert.ok(pack.notes.some((n) => /senior-dev.*no RULES\.md/.test(n)));
    rmSync(dir, { recursive: true, force: true });
  });

  test('a duplicate tier name is refused', () => {
    const dir = buildPack({
      ...VALID,
      'gitagent.yaml': MANIFEST.replace('  - name: senior-dev', '  - name: junior-dev'),
    });
    assert.throws(() => readPack(dir), /declared twice/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('multiple tiers with no DUTIES.md leaves the handoff graph uncontracted', () => {
    const dir = buildPack(VALID);
    rmSync(join(dir, 'DUTIES.md'));
    const pack = readPack(dir);
    assert.ok(pack.notes.some((n) => /no DUTIES\.md/.test(n)));
    rmSync(dir, { recursive: true, force: true });
  });

  // A pack that names a provider or a key env var is choosing where someone
  // else's source code gets sent. That is refused, not warned about.
  for (const key of ['provider', 'name', 'api_key_env', 'base_url']) {
    test(`a pack declaring model.${key} is refused`, () => {
      const dir = buildPack({ ...VALID, 'gitagent.yaml': `${MANIFEST}model:\n  ${key}: something\n` });
      assert.throws(() => readPack(dir), /may not choose your provider or key/);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  test('kind must be AgentPack', () => {
    const dir = buildPack({ ...VALID, 'gitagent.yaml': MANIFEST.replace('AgentPack', 'Agent') });
    assert.throws(() => readPack(dir), /expected "AgentPack"/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('confine — a pack author writes these paths', () => {
  const root = '/repo';

  test('a plain relative path resolves', () => {
    assert.equal(confine(root, 'agents/junior-dev', 'x'), join('agents', 'junior-dev'));
  });

  test('collapses a harmless inner ..', () => {
    assert.equal(confine(root, 'agents/tmp/../junior-dev', 'x'), join('agents', 'junior-dev'));
  });

  for (const bad of ['../outside', '../../etc/passwd', 'agents/../../escape']) {
    test(`refuses "${bad}"`, () => {
      assert.throws(() => confine(root, bad, 'x'), /escapes the pack/);
    });
  }

  for (const bad of ['/etc/passwd', 'C:/Windows/System32']) {
    test(`refuses absolute "${bad}"`, () => {
      assert.throws(() => confine(root, bad, 'x'), /absolute path/);
    });
  }

  test('refuses an empty path', () => {
    assert.throws(() => confine(root, '  ', 'x'), /is empty/);
  });

  test('refuses a symlink, which normalize() cannot see', (t) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jra-link-')));
    mkdirSync(join(dir, 'real'));
    try {
      symlinkSync(join(dir, 'real'), join(dir, 'link'), 'dir');
    } catch {
      // Windows needs privilege for symlinks; the guard is still compiled in.
      t.skip('symlink creation not permitted here');
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    assert.throws(() => confine(dir, 'link', 'x'), /symlink/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('inspectHooks', () => {
  test('reports the sealed hooks even when the pack declares none', () => {
    const dir = buildPack(VALID);
    const found = inspectHooks(readPack(dir));
    assert.ok(found.phases.pre_command.includes('no-force-push'));
    assert.ok(found.phases.pre_command.includes('no-sudo'));
    assert.ok(found.phases.pre_edit.includes('secret-scan'));
    rmSync(dir, { recursive: true, force: true });
  });

  // The refusal itself lives in hooks.js. What matters here is that the user
  // is TOLD the pack tried, before the files land rather than never.
  test('surfaces a pack trying to unseal a guardrail', () => {
    const dir = buildPack({
      ...VALID,
      'hooks/hooks.yaml': 'pre_command:\n  - name: no-sudo\n    enabled: false\n    overridable: true\n',
    });
    const found = inspectHooks(readPack(dir));
    assert.ok(found.notes.some((n) => /no-sudo.*sealed/.test(n)), found.notes.join('; '));
    assert.ok(found.phases.pre_command.includes('no-sudo'));
    rmSync(dir, { recursive: true, force: true });
  });

  test('a guardrail file that does not parse fails closed', () => {
    const dir = buildPack({ ...VALID, 'hooks/hooks.yaml': 'pre_edit:\n\t- name: x\n' });
    assert.throws(() => inspectHooks(readPack(dir)), /does not parse/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('installPack', () => {
  test("leaves the pack repo's own housekeeping behind", () => {
    const dir = buildPack({ ...VALID, '.gitignore': 'node_modules\n', '.gitattributes': '* text\n' });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const dest = realpathSync(mkdtempSync(join(tmpdir(), 'jra-dest-')));
    installPack({ dir }, join(dest, '.gitagent'));

    assert.ok(existsSync(join(dest, '.gitagent', 'agents', 'junior-dev', 'SOUL.md')));
    assert.ok(!existsSync(join(dest, '.gitagent', '.gitignore')));
    assert.ok(!existsSync(join(dest, '.gitagent', '.gitattributes')));
    assert.ok(!existsSync(join(dest, '.gitagent', '.git')));

    rmSync(dir, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });
});

describe('patchSequence', () => {
  const doc = 'hooks: hooks/hooks.yaml\n\nagents:\n  - build-doctor\n  - senior-dev\n\nrouting:\n  entry: auto\n';

  test('replaces the item list, not the surrounding file', () => {
    const out = patchSequence(doc, 'agents', ['a', 'b', 'c']);
    assert.match(out, /agents:\n  - a\n  - b\n  - c\n/);
    assert.match(out, /^hooks: hooks\/hooks\.yaml/);
    assert.match(out, /routing:\n  entry: auto/);
  });

  test('shrinking the list does not leave orphaned items', () => {
    const out = patchSequence(doc, 'agents', ['only']);
    assert.ok(!out.includes('build-doctor'));
    assert.ok(!out.includes('senior-dev'));
  });

  test('does not collapse the gap before the next section', () => {
    const out = patchSequence(doc, 'agents', ['a']);
    assert.match(out, /- a\n\nrouting:/);
  });

  test('an absent key throws rather than appending silently', () => {
    assert.throws(() => patchSequence(doc, 'nope', ['a']), /not found/);
  });
});

describe('upsertSection', () => {
  test('appends a section that does not exist yet', () => {
    const out = upsertSection('model:\n  provider: anthropic\n', 'source', 'url: https://x.test\ncommit: abc');
    assert.match(out, /source:\n  url: https:\/\/x\.test\n  commit: abc/);
    assert.match(out, /model:\n  provider: anthropic/);
  });

  test('replaces one that does', () => {
    const first = upsertSection('model:\n  provider: anthropic\n', 'source', 'commit: aaa');
    const second = upsertSection(first, 'source', 'commit: bbb');
    assert.match(second, /commit: bbb/);
    assert.ok(!second.includes('aaa'));
    assert.equal(second.match(/^source:/gm).length, 1);
  });

  test('preserves comments elsewhere in the file', () => {
    const doc = '# keep me\nmodel:\n  provider: anthropic  # and me\n';
    const out = upsertSection(doc, 'source', 'commit: abc');
    assert.match(out, /# keep me/);
    assert.match(out, /# and me/);
  });
});
