import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { classify } from '../src/classify.js';
import { readAgents, buildFixer } from '../src/agents.js';
import { readManifest } from '../src/config.js';
import { TEMPLATES } from '../src/paths.js';

/**
 * A repo where nothing is called build-doctor, junior-dev, senior-dev or
 * ui-editor.
 *
 * The four defaults are a pack, not the product. Every routing decision —
 * which agent takes a red build, who a low-confidence result escalates to, how
 * many attempts each gets, where a failed classification lands — has to work
 * for agents the harness has never heard of. This file is the test that the
 * default names are genuinely gone from the code.
 */

const AGENTS = {
  medic: [
    'name: medic', 'role: Repairs broken builds', 'priority: 0',
    'fixes_build: true', 'attempts: 3', 'terminal: true',
  ],
  scout: [
    'name: scout', 'role: Small scoped edits', 'priority: 10',
    'escalates_to: archivist', 'attempts: 1',
  ],
  archivist: [
    'name: archivist', 'role: Anything structural', 'priority: 90',
    'terminal: true',
  ],
};

function sandbox({ scripts = { test: 'node -e "process.exit(0)"' }, entry = 'scout' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jra-custom-')));
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts }, null, 2));
  writeFileSync(join(root, 'index.js'), 'export const a = 1;\n');

  const dir = join(root, '.gitagent');
  cpSync(TEMPLATES, dir, { recursive: true });
  rmSync(join(dir, 'agents'), { recursive: true, force: true });
  for (const [name, meta] of Object.entries(AGENTS)) {
    mkdirSync(join(dir, 'agents', name), { recursive: true });
    writeFileSync(
      join(dir, 'agents', name, 'SOUL.md'),
      ['---', ...meta, '---', '', `# ${name}`, '', 'Do the work.', ''].join('\n'),
    );
  }

  const file = join(dir, 'agent.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('entry: auto', `entry: ${entry}`));
  writeFileSync(join(root, '.gitignore'), '.gitagent/.env\n.gitagent/.session/\n');
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '--all');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return { root, dir };
}

async function inRepo(box, fn) {
  const prev = process.cwd();
  process.chdir(box.root);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
    rmSync(box.root, { recursive: true, force: true });
  }
}

function scripted(turns) {
  let n = 0;
  const calls = [];
  const fn = async (_m, req) => {
    if (/handing it to someone else/.test(req.system ?? '')) {
      return { text: '{}', toolCalls: [], stopReason: 'end_turn' };
    }
    calls.push(req);
    const t = turns[n++] ?? {};
    return {
      text: t.text ?? '',
      toolCalls: (t.tools ?? []).map(([name, input], i) => ({ id: `c${n}_${i}`, name, input })),
      stopReason: 'tool_use',
    };
  };
  fn.calls = calls;
  return fn;
}
const tool = (name, input) => [name, input];
const reply = (tier, confidence) => JSON.stringify({ tier, confidence, reason: 'because' });

describe('a repo with none of the default agent names', () => {
  test('the roster is whatever is installed', async () => {
    const box = sandbox();
    await inRepo(box, () => {
      assert.deepEqual(readAgents(box.dir).map((a) => a.name), ['medic', 'scout', 'archivist']);
    });
  });

  test('a red build routes to whoever declares fixes_build', async () => {
    const box = sandbox({ entry: 'auto' });
    await inRepo(box, async () => {
      const agents = readAgents(box.dir);
      assert.equal(buildFixer(agents).name, 'medic');

      const out = await classify({
        task: 'anything', buildGreen: false, agents,
        manifest: readManifest(join(box.dir, 'agent.yaml')),
        duties: 'x', call: scripted([]),
      });
      assert.equal(out.tier, 'medic');
      assert.equal(out.source, 'repo-state');
    });
  });

  // The old lookup table had no entry for these names, so a low-confidence
  // result could only fall through to a tier that does not exist here.
  test('a low-confidence result escalates the way the agent declares', async () => {
    const box = sandbox({ entry: 'auto' });
    await inRepo(box, async () => {
      const out = await classify({
        task: 'anything', agents: readAgents(box.dir),
        manifest: readManifest(join(box.dir, 'agent.yaml')),
        duties: 'x', call: scripted([{ text: reply('scout', 0.2) }]),
      });
      assert.equal(out.tier, 'archivist');
      assert.equal(out.source, 'floor-bump');
    });
  });

  test('an unusable classification lands on the last agent by priority', async () => {
    const box = sandbox({ entry: 'auto' });
    await inRepo(box, async () => {
      const out = await classify({
        task: 'anything', agents: readAgents(box.dir),
        manifest: readManifest(join(box.dir, 'agent.yaml')),
        duties: 'x', call: scripted([{ text: 'not json at all' }]),
      });
      assert.equal(out.tier, 'archivist');
      assert.equal(out.source, 'fallback');
    });
  });

  test('a task runs end to end', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const out = await run(['change a thing'], {}, {
        call: scripted([
          { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 2;\n' })] },
          { tools: [tool('done', { summary: 'changed a' })] },
        ]),
      });
      assert.equal(out.status, 'done');
      assert.equal(out.tier, 'scout');
      assert.match(readFileSync(join(box.root, 'index.js'), 'utf8'), /a = 2/);
    });
  });

  // scout declares attempts: 1, so one failure hands straight to archivist.
  test('each agent gets the attempts it declares, then escalates as declared', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted([
        { text: 'no tools' },
        { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 3;\n' })] },
        { tools: [tool('done', { summary: 'archivist finished it' })] },
      ]);
      const out = await run(['change a thing'], {}, { call });

      assert.equal(out.status, 'done');
      assert.equal(out.tier, 'archivist', 'scout should have escalated to the agent it names');
      assert.match(call.calls[1].system, /You are `archivist`/);
    });
  });

  test('the terminal agent stops rather than escalating', async () => {
    const box = sandbox({ entry: 'archivist' });
    await inRepo(box, async () => {
      const out = await run(['impossible'], {}, { call: scripted([{ text: 'no' }, { text: 'no' }]) });
      assert.equal(out.status, 'stopped');
      assert.equal(out.tier, 'archivist');
    });
  });

  test('an agent prompt names its real siblings, not the defaults', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted([{ tools: [tool('done', { summary: 'ok' })] }]);
      await run(['a task'], {}, { call });
      const system = call.calls[0].system;
      assert.match(system, /You are `scout`/);
      assert.match(system, /medic/);
      assert.match(system, /archivist/);
      for (const gone of ['junior-dev', 'senior-dev', 'build-doctor', 'ui-editor']) {
        assert.ok(!system.includes(gone), `the prompt still mentions ${gone}`);
      }
    });
  });
});
