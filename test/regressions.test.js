import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHooks, checkEdit, checkCommand, checkRead } from '../src/hooks.js';
import { init } from '../src/init.js';
import { readAgents, escalationCycle } from '../src/agents.js';
import { run } from '../src/run.js';
import { TEMPLATES } from '../src/paths.js';

/**
 * Bugs that shipped, each pinned by the test that would have caught it.
 */

const tmp = (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

describe('a guard is enforced by what it declares, not by its name', () => {
  // add-guard installed files whose hooks had their own names. The engine only
  // evaluated the built-in names, so those guards loaded, reported success, and
  // protected nothing. A guardrail that silently does nothing is believed.
  function guarded(yaml) {
    const dir = tmp('jra-shape-');
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    cpSync(join(TEMPLATES, 'hooks', 'hooks.yaml'), join(dir, 'hooks', 'hooks.yaml'));
    writeFileSync(join(dir, 'hooks', 'custom.yaml'), yaml);
    return { dir, hooks: loadHooks(dir, { reload: true }) };
  }

  test('a custom-named path guard blocks an edit', () => {
    const { dir, hooks } = guarded('pre_edit:\n  - name: keep-payments-safe\n    paths:\n      - "payments/**"\n');
    const v = checkEdit('payments/charge.js', { before: null, after: 'x' }, 'anyone', hooks);
    assert.equal(v.allowed, false);
    assert.equal(v.blocked[0].hook, 'keep-payments-safe');
    rmSync(dir, { recursive: true, force: true });
  });

  test('severity: checkpoint asks instead of blocking', () => {
    const { dir, hooks } = guarded('pre_edit:\n  - name: schema-review\n    severity: checkpoint\n    paths:\n      - "migrations/**"\n');
    const v = checkEdit('migrations/9.sql', { before: null, after: 'x' }, 'anyone', hooks);
    assert.equal(v.allowed, true);
    assert.ok(v.warnings.some((w) => w.checkpoint && w.hook === 'schema-review'));
    rmSync(dir, { recursive: true, force: true });
  });

  test('severity: warn notes without stopping', () => {
    const { dir, hooks } = guarded('pre_edit:\n  - name: heads-up\n    severity: warn\n    paths:\n      - "docs/**"\n');
    const v = checkEdit('docs/a.md', { before: null, after: 'x' }, 'anyone', hooks);
    assert.equal(v.allowed, true);
    assert.ok(v.warnings.some((w) => w.hook === 'heads-up' && !w.checkpoint));
    rmSync(dir, { recursive: true, force: true });
  });

  test('a custom command guard blocks the command', () => {
    const { dir, hooks } = guarded('pre_command:\n  - name: no-terraform\n    commands: ["terraform"]\n');
    assert.equal(checkCommand(['terraform', 'apply'], 'anyone', hooks).allowed, false);
    assert.equal(checkCommand(['npm', 'test'], 'anyone', hooks).allowed, true);
    rmSync(dir, { recursive: true, force: true });
  });

  // Blocking `cat` while read_file succeeds moves the leak one tool over.
  test('a custom command path guard also covers read_file', () => {
    const { dir, hooks } = guarded('pre_command:\n  - name: no-card-data\n    paths:\n      - "cards/**"\n');
    assert.equal(checkCommand(['cat', 'cards/live.csv'], 'anyone', hooks).allowed, false);
    assert.equal(checkRead('cards/live.csv', 'anyone', hooks).allowed, false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('applies_to limits a guard to the agents it names', () => {
    const { dir, hooks } = guarded('pre_edit:\n  - name: ui-only-fence\n    applies_to: [designer]\n    paths:\n      - "server/**"\n');
    assert.equal(checkEdit('server/a.js', { before: null, after: 'x' }, 'designer', hooks).allowed, false);
    assert.equal(checkEdit('server/a.js', { before: null, after: 'x' }, 'backend', hooks).allowed, true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('enabled: false switches a custom guard off', () => {
    const { dir, hooks } = guarded('pre_edit:\n  - name: paused\n    enabled: false\n    paths:\n      - "x/**"\n');
    assert.equal(checkEdit('x/a.js', { before: null, after: 'x' }, 'anyone', hooks).allowed, true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('init --from after the agents: list was removed', () => {
  // agent.yaml lost its `agents:` block, but init --from still tried to rewrite
  // it and threw "Key agents: not found" — installing a pack was broken.
  test('installs a pack from a local git repo', async () => {
    const pack = tmp('jra-localpack-');
    const git = (...a) => execFileSync('git', a, { cwd: pack, stdio: 'pipe' });
    writeFileSync(join(pack, 'gitagent.yaml'), [
      'apiVersion: gitagent/v1', 'kind: AgentPack', 'metadata:', '  name: tiny', '  version: 1.0.0',
      'agents:', '  - name: helper', '    path: agents/helper',
      'routing:', '  entry: auto',
    ].join('\n'));
    mkdirSync(join(pack, 'agents', 'helper'), { recursive: true });
    writeFileSync(join(pack, 'agents', 'helper', 'SOUL.md'), '---\nname: helper\nrole: helps\nterminal: true\n---\n\n# Helper\n');
    writeFileSync(join(pack, 'agents', 'helper', 'RULES.md'), '# Rules\n');
    writeFileSync(join(pack, 'DUTIES.md'), '# Duties\n');
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '--all');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'pack');

    const repo = tmp('jra-target-');
    mkdirSync(join(repo, '.git'));
    const prev = process.cwd();
    process.chdir(repo);
    try {
      await init({ from: pack, quiet: true });
      const dir = join(repo, '.gitagent');
      assert.ok(existsSync(join(dir, 'agent.yaml')));
      assert.deepEqual(readAgents(dir).map((a) => a.name), ['helper']);
      assert.ok(!/^agents:/m.test(readFileSync(join(dir, 'agent.yaml'), 'utf8')), 'an agents: list was written back');
    } finally {
      process.chdir(prev);
      rmSync(repo, { recursive: true, force: true });
      rmSync(pack, { recursive: true, force: true });
    }
  });
});

describe('an escalation loop cannot hang a run', () => {
  // Hand-written agents that name each other — A escalates to B, B to A — used
  // to pass a task round forever, each getting one more attempt past its limit.
  function loopRepo() {
    const root = tmp('jra-loop-');
    const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'd', scripts: { test: 'node -e 0' } }));
    const dir = join(root, '.gitagent');
    cpSync(TEMPLATES, dir, { recursive: true });
    rmSync(join(dir, 'agents'), { recursive: true, force: true });
    for (const [name, to] of [['ping', 'pong'], ['pong', 'ping']]) {
      mkdirSync(join(dir, 'agents', name), { recursive: true });
      writeFileSync(join(dir, 'agents', name, 'SOUL.md'), `---\nname: ${name}\npriority: 10\nescalates_to: ${to}\nattempts: 1\n---\n\n# ${name}\n`);
    }
    const mf = join(dir, 'agent.yaml');
    writeFileSync(mf, readFileSync(mf, 'utf8').replace('entry: auto', 'entry: ping'));
    writeFileSync(join(root, '.gitignore'), '.gitagent/.env\n.gitagent/.session/\n');
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '--all');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i');
    return { root, dir };
  }

  test('the loop is detectable before a run', () => {
    const { root, dir } = loopRepo();
    assert.deepEqual(escalationCycle(readAgents(dir))?.sort(), ['ping', 'pong']);
    rmSync(root, { recursive: true, force: true });
  });

  test('a run through the loop stops instead of spinning', async () => {
    const { root } = loopRepo();
    const prev = process.cwd();
    process.chdir(root);
    let calls = 0;
    const call = async (_m, req) => {
      if (/handing it to someone else/.test(req.system ?? '')) return { text: '{}', toolCalls: [] };
      calls++;
      if (calls > 50) throw new Error('the run is looping');
      return { text: 'no tool', toolCalls: [] };
    };
    try {
      // Verify is irrelevant to routing and costs a process spawn per attempt.
      const out = await run(['task'], { 'skip-verify': true }, { call });
      assert.equal(out.status, 'stopped');
      assert.ok(calls <= 4, `made ${calls} task calls — it looped`);
    } finally {
      process.chdir(prev);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
