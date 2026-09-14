import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, inside, TOOLS } from '../src/tools.js';
import { loadHooks } from '../src/hooks.js';
import { TEMPLATES } from '../src/paths.js';

/**
 * The tool surface is where an arbitrary model meets the user's filesystem, so
 * these tests are mostly about what does NOT happen.
 *
 * The recurring assertion is `isError` rather than `assert.throws`: a blocked
 * call has to come back to the model as a readable tool error so it can
 * correct, because the block reasons in hooks.js are written as instructions to
 * the agent. A throw would end the run and waste every one of them.
 */

let root;
let ctx;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jra-tools-')));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'api'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.css'), 'body { color: red; }\n');
  writeFileSync(join(root, 'src', 'index.js'), 'export const a = 1;\n');
  writeFileSync(join(root, 'api', 'handler.js'), 'export function h() {}\n');
  writeFileSync(join(root, '.env'), 'SECRET=hunter2\n');

  const dir = join(root, '.gitagent');
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  cpSync(join(TEMPLATES, 'hooks', 'hooks.yaml'), join(dir, 'hooks', 'hooks.yaml'));

  ctx = {
    root,
    dir,
    hooks: loadHooks(dir, { reload: true }),
    tiers: ['build-doctor', 'junior-dev', 'ui-editor', 'senior-dev'],
    tier: 'junior-dev',
    session: { transcript: join(root, 'transcript.jsonl'), attempts: [] },
    touched: new Set(),
  };
});

after(() => rmSync(root, { recursive: true, force: true }));

const call = (name, input, over = {}) => dispatch({ name, input }, { ...ctx, ...over });

describe('inside — confining a model-supplied path', () => {
  test('accepts a repo-relative path', async () => {
    assert.equal(inside('/repo', 'src/index.js').path, 'src/index.js');
  });

  for (const bad of ['../secrets', '../../etc/passwd', 'src/../../escape']) {
    test(`refuses "${bad}"`, async () => {
      assert.match(inside('/repo', bad).error, /outside the repository/);
    });
  }

  test('refuses an empty path', async () => {
    assert.match(inside('/repo', '  ').error, /required/);
  });
});

describe('read_file', () => {
  test('reads a normal file', async () => {
    const r = await call('read_file', { path: 'src/index.js' });
    assert.equal(r.isError, false);
    assert.match(r.content, /export const a = 1/);
  });

  // Blocking `cat .env` while allowing read_file('.env') moves the leak one
  // tool over. protected-read is sealed, so this cannot be switched off.
  test('.env is blocked, and the model is told which hook stopped it', async () => {
    const r = await call('read_file', { path: '.env' });
    assert.equal(r.isError, true);
    assert.match(r.content, /protected-read/);
    assert.ok(!r.content.includes('hunter2'));
  });

  test('escaping the repo is refused before any hook runs', async () => {
    const r = await call('read_file', { path: '../../../etc/passwd' });
    assert.equal(r.isError, true);
    assert.match(r.content, /outside the repository/);
  });

  test('a missing file is an error, not a crash', async () => {
    assert.equal((await call('read_file', { path: 'nope.js' })).isError, true);
  });
});

describe('write_file', () => {
  test('writes and records the path as touched', async () => {
    const touched = new Set();
    const r = await call('write_file', { path: 'src/new.js', content: 'export const b = 2;\n' }, { touched });
    assert.equal(r.isError, false);
    assert.equal(readFileSync(join(root, 'src/new.js'), 'utf8'), 'export const b = 2;\n');
    assert.ok(touched.has('src/new.js'));
  });

  test('a credential-shaped string is blocked', async () => {
    const r = await call('write_file', { path: 'src/leak.js', content: 'const k = "sk-abcdefghijklmnopqrstuvwxyz0123";\n' });
    assert.equal(r.isError, true);
    assert.match(r.content, /secret-scan/);
    assert.ok(!existsSync(join(root, 'src/leak.js')), 'the file must not be written');
  });

  test('.env is blocked by protected-paths', async () => {
    const r = await call('write_file', { path: '.env', content: 'X=1\n' });
    assert.equal(r.isError, true);
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'SECRET=hunter2\n');
  });

  // The scope fence is structural because a persona prompt will not hold this
  // boundary — that is the whole reason it is a hook.
  test('ui-editor may edit a stylesheet', async () => {
    const r = await call('write_file', { path: 'src/app.css', content: 'body { color: blue; }\n' }, { tier: 'ui-editor' });
    assert.equal(r.isError, false);
  });

  test('ui-editor may not edit api/, and is told to hand off', async () => {
    const r = await call('write_file', { path: 'api/handler.js', content: 'export function h() { return 1; }\n' }, { tier: 'ui-editor' });
    assert.equal(r.isError, true);
    assert.match(r.content, /scope-fence/);
    assert.match(r.content, /[Hh]and off/);
  });

  test('junior-dev may edit api/ — the fence is per tier', async () => {
    const r = await call('write_file', { path: 'api/handler.js', content: 'export function h() { return 2; }\n' });
    assert.equal(r.isError, false);
  });

  test('content must be a string', async () => {
    assert.equal((await call('write_file', { path: 'src/x.js', content: 42 })).isError, true);
  });
});

describe('run_command', () => {
  test('argv must be an array, not a shell string', async () => {
    const r = await call('run_command', { command: 'npm test' });
    assert.equal(r.isError, true);
    assert.match(r.content, /array of strings/);
  });

  test('sudo is blocked', async () => {
    const r = await call('run_command', { command: ['sudo', 'rm', '-rf', '/'] });
    assert.equal(r.isError, true);
    assert.match(r.content, /no-sudo/);
  });

  test('force push is blocked', async () => {
    const r = await call('run_command', { command: ['git', 'push', '--force'] });
    assert.equal(r.isError, true);
    assert.match(r.content, /no-force-push/);
  });

  test('a command naming .env is blocked', async () => {
    const r = await call('run_command', { command: ['cat', '.env'] });
    assert.equal(r.isError, true);
    assert.match(r.content, /protected-read/);
  });

  test('a harmless command runs and returns output', async () => {
    const r = await call('run_command', { command: [process.execPath, '-e', 'console.log("hi")'] });
    assert.equal(r.isError, false);
    assert.match(r.content, /hi/);
  });

  // A failing test IS the answer to "run the tests" — the model needs the
  // output, and the harness has not malfunctioned.
  test('a non-zero exit returns output as a tool error, not a throw', async () => {
    const r = await call('run_command', { command: [process.execPath, '-e', 'console.error("boom"); process.exit(3)'] });
    assert.equal(r.isError, true);
    assert.match(r.content, /Exit 3/);
    assert.match(r.content, /boom/);
  });
});

// A checkpoint used to be asked AFTER the tool ran: `npm install lodash` had
// already changed the dependencies by the time "Allow?" appeared, so "no"
// changed nothing. Now the question comes first and "no" means nothing happens.
describe('human checkpoints are asked before the action', () => {
  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');

  test('a declined write leaves the file unwritten, and the model is told', async () => {
    const asked = [];
    const r = await call('write_file', { path: 'src/huge.js', content: big }, {
      approve: async (cp) => { asked.push(cp.hook); return false; },
    });
    assert.deepEqual(asked, ['diff-ceiling']);
    assert.equal(r.isError, true);
    assert.match(r.content, /human approval/);
    assert.ok(!existsSync(join(root, 'src/huge.js')), 'a declined write must not land');
  });

  test('an approved write lands, and the file did not exist while asking', async () => {
    let existedWhileAsking = null;
    const r = await call('write_file', { path: 'src/huge2.js', content: big }, {
      approve: async () => { existedWhileAsking = existsSync(join(root, 'src/huge2.js')); return true; },
    });
    assert.equal(existedWhileAsking, false);
    assert.equal(r.isError, false);
    assert.ok(existsSync(join(root, 'src/huge2.js')));
  });

  test('a declined command is never run', async () => {
    const marker = join(root, 'ran.txt');
    const r = await call('run_command', {
      command: ['npm', 'install', 'lodash', `--prefix=${marker}`],
    }, { approve: async () => false });
    assert.equal(r.isError, true);
    assert.match(r.content, /dep-change/);
    assert.ok(!existsSync(marker));
  });

  test('with nobody to ask, a checkpoint declines', async () => {
    const r = await call('write_file', { path: 'src/huge3.js', content: big });
    assert.equal(r.isError, true);
    assert.ok(!existsSync(join(root, 'src/huge3.js')));
  });
});

describe('control tools', () => {
  test('handoff returns a control signal', async () => {
    const r = await call('handoff', { to: 'senior-dev', reason: 'cross-cutting' });
    assert.equal(r.control.kind, 'handoff');
    assert.equal(r.control.to, 'senior-dev');
  });

  test('handing off to an uninstalled tier is refused', async () => {
    const r = await call('handoff', { to: 'architect', reason: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.content, /No tier "architect"/);
  });

  test('handing off to yourself is refused as a loop', async () => {
    const r = await call('handoff', { to: 'junior-dev', reason: 'x' });
    assert.equal(r.isError, true);
    assert.match(r.content, /loop/);
  });

  test('done returns a control signal with the summary', async () => {
    const r = await call('done', { summary: 'Added b to src/new.js' });
    assert.equal(r.control.kind, 'done');
    assert.match(r.control.summary, /Added b/);
  });
});

describe('malformed calls', () => {
  test('an unknown tool name lists the real ones', async () => {
    const r = await call('delete_everything', {});
    assert.equal(r.isError, true);
    assert.match(r.content, /read_file/);
  });

  // provider.js hands malformed tool arguments through as __parseError rather
  // than crashing, so the model can be told and retry.
  test('unparseable tool arguments come back as a tool error', async () => {
    const r = await call('write_file', { __parseError: '{"path": "x", ' });
    assert.equal(r.isError, true);
    assert.match(r.content, /not valid JSON/);
  });
});

describe('the tool schemas', () => {
  test('run_command declares an array, which is what makes the gate work', async () => {
    const cmd = TOOLS.find((t) => t.name === 'run_command');
    assert.equal(cmd.input_schema.properties.command.type, 'array');
    assert.equal(cmd.input_schema.properties.command.items.type, 'string');
  });

  test('every tool has a name, description, and object schema', async () => {
    for (const t of TOOLS) {
      assert.ok(t.name && t.description, `${t.name} is underspecified`);
      assert.equal(t.input_schema.type, 'object');
    }
  });
});
