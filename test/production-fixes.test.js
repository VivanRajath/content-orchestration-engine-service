import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/run.js';
import { classify } from '../src/classify.js';
import { requiresKey, isLocal, callModel, forgetCaps } from '../src/provider.js';
import { TEMPLATES } from '../src/paths.js';

/**
 * Failures found by reading the code for what a real repository would do to it,
 * rather than what a test fixture does.
 *
 * Each case here is a thing that went wrong quietly: work committed that nobody
 * checked, a rollback that did not roll back, a build gate that stopped gating.
 * The point of a test is that the next person finds out loudly.
 */

let seq = 0;
const nextId = () => `call_${++seq}`;

function scripted(turns) {
  const calls = [];
  const fn = async (_manifest, req) => {
    if (/handing it to someone else/.test(req.system ?? '')) {
      return { text: '{}', toolCalls: [], stopReason: 'end_turn' };
    }
    calls.push(req);
    const turn = turns[calls.length - 1];
    if (!turn) return { text: 'done thinking', toolCalls: [], stopReason: 'end_turn' };
    return {
      text: turn.text ?? '',
      toolCalls: (turn.tools ?? []).map((t) => ({ id: nextId(), name: t[0], input: t[1] })),
      stopReason: 'tool_use',
    };
  };
  fn.calls = calls;
  return fn;
}

const tool = (name, input) => [name, input];

function sandbox({ scripts = { test: 'node -e "process.exit(0)"' }, commit = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jra-prod-')));
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, stdio: 'pipe' });

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts }, null, 2));
  writeFileSync(join(root, 'index.js'), 'export const a = 1;\n');
  writeFileSync(join(root, '.gitignore'), '.gitagent/.env\n.gitagent/.session/\n');

  const dir = join(root, '.gitagent');
  cpSync(TEMPLATES, dir, { recursive: true });
  const file = join(dir, 'agent.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('entry: auto', 'entry: junior-dev'));

  git('init', '-q');
  if (commit) {
    git('add', '--all');
    git('commit', '-q', '-m', 'init');
  }
  return { root, dir, git };
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

const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

describe('a commit contains the attempt, and only the attempt', () => {
  test('work the user had not committed is left alone', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      // The chat runs with --allow-dirty, so the user's own half-finished edit
      // is routinely sitting in the tree while an agent works. `git add --all`
      // committed it under the agent's name.
      writeFileSync(join(box.root, 'my-notes.txt'), 'mine, not the agent’s\n');

      const call = scripted([
        { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 2;\n' })] },
        { tools: [tool('done', { summary: 'bumped a' })] },
      ]);
      const out = await run(['bump a'], { 'allow-dirty': true, quiet: true }, { call });
      assert.equal(out.status, 'done');

      const committed = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], {
        cwd: box.root, encoding: 'utf8',
      }).trim().split('\n').filter(Boolean);

      assert.deepEqual(committed, ['index.js']);
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: box.root, encoding: 'utf8' });
      assert.match(status, /my-notes\.txt/, 'the user’s file is still uncommitted, where they left it');
    });
  });

  test('a file written by a command is scanned before it is committed', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      // write_file is gated by the secret scanner. A command that writes a file
      // is not, so the commit gate is the last chance to catch it — and it used
      // to look only at paths write_file had touched.
      const leak = 'const KEY = "sk-proj-Ab3kR9xQ2mZpL7vN4tY8wE1sD6fG0hJ5cV2bN9mK4pQ7rT3x";';
      const call = scripted([
        { tools: [tool('run_command', { command: ['node', '-e', `require('fs').writeFileSync('leak.js', ${JSON.stringify(leak)})`] })] },
        { tools: [tool('done', { summary: 'wrote a file with a command' })] },
      ]);
      await run(['write it'], { quiet: true }, { call });

      const log = execFileSync('git', ['log', '--oneline'], { cwd: box.root, encoding: 'utf8' });
      assert.equal(log.trim().split('\n').length, 1, 'the credential must not reach history');
      assert.ok(existsSync(join(box.root, 'leak.js')), 'the file stays in the tree for the user to deal with');
    });
  });
});

describe('a repository git cannot undo work in', () => {
  test('a repo with no commits is refused, with the command that fixes it', async () => {
    const box = sandbox({ commit: false });
    await inRepo(box, async () => {
      const call = scripted([{ tools: [tool('done', { summary: 'never runs' })] }]);
      await assert.rejects(
        () => run(['anything'], { 'allow-dirty': true, quiet: true }, { call }),
        /no commits yet[\s\S]*initial commit/,
      );
      assert.equal(call.calls.length, 0, 'and not a single token was spent finding out');
    });
  });

  test('--no-git is the way to say you accept it', async () => {
    const box = sandbox({ commit: false });
    await inRepo(box, async () => {
      const call = scripted([
        { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 3;\n' })] },
        { tools: [tool('done', { summary: 'edited' })] },
      ]);
      const out = await run(['edit it'], { 'allow-dirty': true, quiet: true, 'no-git': true }, { call });
      assert.equal(out.status, 'done');
      assert.match(read(box.root, 'index.js'), /a = 3/);
    });
  });
});

describe('the build gate', () => {
  test('the chat reuses the build state it just verified', async () => {
    // Twice per message on a repo whose suite takes minutes is the difference
    // between usable and not. The post-task verify still runs for real.
    const box = sandbox({ scripts: { test: 'node -e "require(\'fs\').appendFileSync(\'runs.log\',\'x\')"' } });
    await inRepo(box, async () => {
      const call = scripted([
        { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 5;\n' })] },
        { tools: [tool('done', { summary: 'edited' })] },
      ]);
      const out = await run(['edit'], { quiet: true }, { call });
      const withoutCache = read(box.root, 'runs.log').length;
      assert.equal(withoutCache, 2, 'entry check plus the check that gates the commit');

      const call2 = scripted([
        { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 6;\n' })] },
        { tools: [tool('done', { summary: 'edited again' })] },
      ]);
      await run(['edit again'], { quiet: true, 'allow-dirty': true }, { call: call2, build: out.build });
      assert.equal(read(box.root, 'runs.log').length, 3, 'the handed-in state replaced the entry check only');
    });
  });
});

describe('configuration a real setup actually has', () => {
  test('a local endpoint needs no API key', () => {
    assert.equal(requiresKey({ provider: 'ollama' }), false);
    assert.equal(requiresKey({ provider: 'openai-compatible', baseUrl: 'http://localhost:8000/v1' }), false);
    assert.equal(requiresKey({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1' }), false);
    assert.equal(requiresKey({ provider: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1' }), true);
    assert.equal(requiresKey({ provider: 'groq' }), true);
    assert.equal(isLocal('not a url'), false);
  });

  test('classification survives a deleted DUTIES.md', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      rmSync(join(box.dir, 'DUTIES.md'));
      const call = async () => ({
        text: '{"tier":"junior-dev","confidence":0.9,"reason":"small change"}',
        toolCalls: [],
        stopReason: 'end_turn',
      });
      const out = await classify({
        task: 'rename a variable',
        manifest: { entry: 'auto', confidenceFloor: 0.6 },
        dir: box.dir,
        call,
      });
      assert.equal(out.tier, 'junior-dev');
    });
  });
});

describe('a model that refuses the parameters we send', () => {
  test('max_tokens is resent as max_completion_tokens, then remembered', async () => {
    forgetCaps();
    const sent = [];
    const realFetch = globalThis.fetch;
    process.env.JRA_PARAM_KEY = 'x';
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      sent.push(body);
      if (body.max_tokens !== undefined) {
        return {
          ok: false,
          status: 400,
          headers: { get: () => null },
          text: async () => JSON.stringify({
            error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      };
    };

    const manifest = { provider: 'openai', model: 'o-whatever', keyEnv: 'JRA_PARAM_KEY', baseUrl: null, maxTokens: 500 };
    try {
      const first = await callModel(manifest, { messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(first.text, 'ok');
      assert.equal(sent.length, 2, 'refused once, adapted, and resent');
      assert.equal(sent[1].max_completion_tokens, 500);
      assert.equal(sent[1].max_tokens, undefined);

      await callModel(manifest, { messages: [{ role: 'user', content: 'again' }] });
      assert.equal(sent.length, 3, 'the second call did not have to fail first');
      assert.equal(sent[2].max_completion_tokens, 500);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.JRA_PARAM_KEY;
      forgetCaps();
    }
  });

  test('a temperature the model will not take is dropped', async () => {
    forgetCaps();
    const sent = [];
    const realFetch = globalThis.fetch;
    process.env.JRA_PARAM_KEY = 'x';
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      sent.push(body);
      if (body.temperature !== undefined) {
        return {
          ok: false,
          status: 400,
          headers: { get: () => null },
          text: async () => JSON.stringify({
            error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) is supported." },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { content: 'fine' }, finish_reason: 'stop' }] }),
      };
    };

    try {
      const res = await callModel(
        { provider: 'openai', model: 'o-strict', keyEnv: 'JRA_PARAM_KEY', baseUrl: null, maxTokens: 300 },
        { messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 },
      );
      assert.equal(res.text, 'fine');
      assert.equal(sent[1].temperature, undefined);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.JRA_PARAM_KEY;
      forgetCaps();
    }
  });
});
