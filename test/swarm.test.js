import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { TEMPLATES } from '../src/paths.js';

/**
 * Swarm, and the rule the whole design rests on: a failed agent rolls back its
 * own files and nothing else. A whole-tree reset would take a sibling's
 * successful work with it, which is the one failure that makes a swarm useless.
 */

let seq = 0;

/** A model that answers as whichever agent the system prompt names. */
function scripted(byAgent) {
  const calls = [];
  const fn = async (_manifest, req) => {
    if (/handing it to someone else/.test(req.system ?? '')) {
      return { text: '{}', toolCalls: [], stopReason: 'end_turn' };
    }
    const who = Object.keys(byAgent).find((n) => req.system?.includes('You are `' + n + '`'));
    calls.push(who);
    const used = calls.filter((x) => x === who).length - 1;
    const t = (byAgent[who] ?? [])[used] ?? {};
    return {
      text: t.text ?? '',
      toolCalls: (t.tools ?? []).map(([name, input]) => ({ id: `c${++seq}`, name, input })),
      stopReason: 'tool_use',
    };
  };
  fn.calls = calls;
  return fn;
}

const tool = (name, input) => [name, input];

/** Two scoped, parallel agents. The default four are removed entirely. */
function sandbox({ test: testScript = 'node -e "process.exit(0)"' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jra-swarm-')));
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: testScript } }, null, 2));
  for (const d of ['src/api', 'src/ui']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'src/api/handler.js'), 'export const api = 1;\n');
  writeFileSync(join(root, 'src/ui/view.js'), 'export const ui = 1;\n');

  const dir = join(root, '.gitagent');
  cpSync(TEMPLATES, dir, { recursive: true });
  rmSync(join(dir, 'agents'), { recursive: true, force: true });
  for (const [name, owns] of [['api-dev', 'src/api/**'], ['ui-dev', 'src/ui/**']]) {
    mkdirSync(join(dir, 'agents', name), { recursive: true });
    writeFileSync(
      join(dir, 'agents', name, 'SOUL.md'),
      ['---', `name: ${name}`, `role: owns ${owns}`, 'priority: 10', 'parallel: true',
        'owns:', `  - "${owns}"`, '---', '', `# ${name}`, ''].join('\n'),
    );
  }
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

const read = (root, p) => readFileSync(join(root, p), 'utf8');
const stuck = [{ text: 'stuck' }, { text: 'still stuck' }, { text: 'giving up' }];

describe('swarm', () => {
  test('two scoped agents run together and both land', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted({
        'api-dev': [
          { tools: [tool('write_file', { path: 'src/api/handler.js', content: 'export const api = 2;\n' })] },
          { tools: [tool('done', { summary: 'api updated' })] },
        ],
        'ui-dev': [
          { tools: [tool('write_file', { path: 'src/ui/view.js', content: 'export const ui = 2;\n' })] },
          { tools: [tool('done', { summary: 'ui updated' })] },
        ],
      });
      const out = await run(['update both layers'], { swarm: true }, { call });

      assert.equal(out.status, 'done');
      assert.match(read(box.root, 'src/api/handler.js'), /api = 2/);
      assert.match(read(box.root, 'src/ui/view.js'), /ui = 2/);
    });
  });

  test('a failed agent rolls back only its own files', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted({
        'api-dev': [
          { tools: [tool('write_file', { path: 'src/api/handler.js', content: 'export const api = 999;\n' })] },
          ...stuck,
        ],
        'ui-dev': [
          { tools: [tool('write_file', { path: 'src/ui/view.js', content: 'export const ui = 2;\n' })] },
          { tools: [tool('done', { summary: 'ui updated' })] },
        ],
      });
      const out = await run(['update both layers'], { swarm: true }, { call });

      // The sibling that succeeded keeps its work...
      assert.match(read(box.root, 'src/ui/view.js'), /ui = 2/, "the succeeding agent's work was destroyed");
      // ...and the one that failed is back where it started.
      assert.match(read(box.root, 'src/api/handler.js'), /api = 1/, 'the failed agent left its edit behind');
      assert.equal(out.status, 'partial');
    });
  });

  test('a file the failed agent created is removed, not left behind', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted({
        'api-dev': [
          { tools: [tool('write_file', { path: 'src/api/scratch.js', content: 'export const s = 1;\n' })] },
          ...stuck,
        ],
        'ui-dev': [
          { tools: [tool('write_file', { path: 'src/ui/view.js', content: 'export const ui = 3;\n' })] },
          { tools: [tool('done', { summary: 'ui updated' })] },
        ],
      });
      await run(['both'], { swarm: true }, { call });

      assert.ok(!existsSync(join(box.root, 'src/api/scratch.js')), 'a created file survived the rollback');
      assert.match(read(box.root, 'src/ui/view.js'), /ui = 3/);
    });
  });

  test('every agent failing is a stop, not a silent success', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted({ 'api-dev': stuck, 'ui-dev': stuck });
      const out = await run(['both'], { swarm: true }, { call });
      assert.equal(out.status, 'stopped');
      assert.match(read(box.root, 'src/api/handler.js'), /api = 1/);
      assert.match(read(box.root, 'src/ui/view.js'), /ui = 1/);
    });
  });

  // Fanning out by default would multiply a token bill nobody agreed to.
  test('a red build is not committed over', async () => {
    // Each frame closed with no verify result, and an unknown build only warns,
    // so a swarm used to commit work that broke the build the ladder would have
    // sent to a repairer.
    const box = sandbox({ test: 'node -e "process.exit(1)"' });
    await inRepo(box, async () => {
      const call = scripted({
        'api-dev': [
          { tools: [tool('write_file', { path: 'src/api/handler.js', content: 'export const api = 3;\n' })] },
          { tools: [tool('done', { summary: 'api updated' })] },
        ],
        'ui-dev': [
          { tools: [tool('write_file', { path: 'src/ui/view.js', content: 'export const ui = 3;\n' })] },
          { tools: [tool('done', { summary: 'ui updated' })] },
        ],
      });
      const out = await run(['update both layers'], { swarm: true }, { call });

      assert.notEqual(out.status, 'done', 'a red build is not a success');
      const log = execFileSync('git', ['log', '--oneline'], { cwd: box.root, encoding: 'utf8' });
      assert.equal(log.trim().split('\n').length, 1, 'nothing landed on top of the red build');
      // The work is still there: the user decides, the harness does not discard
      // a successful agent's edits because a sibling broke the build.
      assert.match(read(box.root, 'src/api/handler.js'), /api = 3/);
    });
  });

  test('without --swarm one agent runs, as before', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted({
        'api-dev': [{ tools: [tool('done', { summary: 'just me' })] }],
        'ui-dev': [{ tools: [tool('done', { summary: 'just me' })] }],
      });
      const out = await run(['a task'], { agent: 'api-dev' }, { call });
      assert.equal(out.status, 'done');
      assert.deepEqual([...new Set(call.calls)], ['api-dev']);
    });
  });
});
