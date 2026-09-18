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
import { ensureRepo } from '../src/onboard.js';
import { scriptedPrompter } from '../src/prompter.js';

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

describe('a model that cannot do this at all', () => {
  test('stops after one attempt instead of climbing the ladder', async () => {
    // Reported from a real session: groq/compound-mini does not support tool
    // calling, so the answer is the same every time. The ladder spent two
    // attempts at one agent, escalated, spent two more, and printed the same
    // sentence four times — four paid requests to learn it once.
    const box = sandbox();
    await inRepo(box, async () => {
      const { ProviderError } = await import('../src/provider.js');
      let calls = 0;
      const refuses = async () => {
        calls++;
        throw new ProviderError(
          'Groq cannot use groq/compound-mini for this: `tool calling` is not supported with this model',
          { kind: 'model', provider: 'groq', model: 'groq/compound-mini' },
        );
      };

      const out = await run(['can u tell me what this repo is about'], { quiet: true }, { call: refuses });

      assert.equal(out.status, 'stopped');
      assert.equal(out.fatal, 'model', 'the outcome says what kind of dead end this was');
      assert.match(out.reason, /tool calling/);
      assert.equal(calls, 1, 'one request, not one per attempt per agent');
    });
  });

  test('a rate limit is still retried, because it is weather', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const { ProviderError } = await import('../src/provider.js');
      let calls = 0;
      const throttled = async () => {
        calls++;
        throw new ProviderError('Groq rate limit reached', { kind: 'rate-limit' });
      };

      await run(['do a thing'], { quiet: true }, { call: throttled });
      assert.ok(calls > 1, 'a transient failure keeps its attempts');
    });
  });
});

describe('a key with a small per-minute allowance', () => {
  test('the loop fits the request instead of being refused by the provider', async () => {
    // The reported session, reproduced: 8,000 tokens a minute, and an agent
    // that reads a 7,300-token README. Before this, the request went out at
    // 10,664 tokens, was refused, had its REPLY cap shrunk — the half that was
    // not the problem — and was refused again at 10,733.
    const box = sandbox();
    await inRepo(box, async () => {
      const file = join(box.dir, 'agent.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace(
        '  max_tokens: 8192',
        '  max_tokens: 4000\n  tokens_per_minute: 8000',
      ));
      // A README the size of this project's own.
      writeFileSync(join(box.root, 'BIG.md'), 'lorem ipsum dolor sit amet. '.repeat(1100));

      const { estimateRequest } = await import('../src/budget.js');
      const sizes = [];
      const call = async (_manifest, req) => {
        if (/handing it to someone else/.test(req.system ?? '')) {
          return { text: '{}', toolCalls: [], stopReason: 'end_turn' };
        }
        sizes.push({
          tokens: estimateRequest({ system: req.system, messages: req.messages, tools: req.tools }),
          maxTokens: req.maxTokens ?? null,
        });
        const step = sizes.length;
        if (step === 1) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'BIG.md' } }], stopReason: 'tool_use' };
        }
        return { text: '', toolCalls: [{ id: 'c2', name: 'done', input: { summary: 'read it' } }], stopReason: 'tool_use' };
      };

      const out = await run(['summarise BIG.md'], { quiet: true, 'allow-dirty': true }, { call });
      assert.equal(out.status, 'done');

      // Every request, prompt plus the reply it is allowed to generate, has to
      // land under what the key permits — that is the number the provider
      // checks.
      for (const { tokens, maxTokens } of sizes) {
        assert.ok(
          tokens + (maxTokens ?? 4000) <= 8000,
          `a request of ${tokens} + ${maxTokens} exceeds the 8,000 the key allows`,
        );
      }
      assert.ok(sizes.length >= 2, 'the task still ran to completion');
    });
  });

  test('a file too big for the budget is cut, and says so', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const file = join(box.dir, 'agent.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace('  max_tokens: 8192', '  max_tokens: 2000\n  tokens_per_minute: 8000'));
      writeFileSync(join(box.root, 'BIG.md'), 'x'.repeat(200000));

      let toolResult = null;
      const call = async (_m, req) => {
        if (/handing it to someone else/.test(req.system ?? '')) return { text: '{}', toolCalls: [], stopReason: 'end_turn' };
        const last = req.messages[req.messages.length - 1];
        if (last?.role === 'tool') toolResult = last.results[0].content;
        if (toolResult) return { text: '', toolCalls: [{ id: 'd', name: 'done', input: { summary: 'ok' } }], stopReason: 'tool_use' };
        return { text: '', toolCalls: [{ id: 'r', name: 'read_file', input: { path: 'BIG.md' } }], stopReason: 'tool_use' };
      };

      await run(['read it'], { quiet: true, 'allow-dirty': true }, { call });

      assert.ok(toolResult, 'the read happened');
      assert.ok(toolResult.length < 200000, 'and was cut to something the key can carry');
      // Plain digits: model-facing text must not depend on the machine's locale.
      assert.match(toolResult, /200000 characters/, 'the model is told what it did not get');
      assert.match(toolResult, /fits in one request on this key/);
    });
  });

  test('a prompt bigger than the whole budget is refused before any request', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const file = join(box.dir, 'agent.yaml');
      // 1,200 tokens a minute cannot carry a 2,000-token agent prompt.
      writeFileSync(file, readFileSync(file, 'utf8').replace('  max_tokens: 8192', '  max_tokens: 500\n  tokens_per_minute: 1200'));

      let calls = 0;
      const call = async () => { calls++; return { text: '', toolCalls: [], stopReason: 'end_turn' }; };
      const out = await run(['anything'], { quiet: true, 'allow-dirty': true }, { call });

      assert.equal(out.status, 'stopped');
      assert.equal(out.fatal, 'budget');
      assert.match(out.reason, /no room left to work in/);
      assert.equal(calls, 0, 'nothing was spent finding out');
    });
  });
});

describe('a folder that is not a git repository yet', () => {
  /**
   * Reported from a real session: `npx jr-arch` in a plain folder. Setup and
   * /prompt both ran — spending model calls — and then every task was refused
   * with advice to pass `--no-git`, which nobody inside a chat can do. Typing
   * "yes" was read as a new task and refused again.
   */
  /** A plain folder, with the two things that must never reach a first commit. */
  function plainFolder() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'jra-nogit-')));
    writeFileSync(join(root, 'index.html'), '<h1>landing</h1>\n');
    mkdirSync(join(root, 'node_modules', 'jr-arch'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'jr-arch', 'index.js'), '// installed\n');
    mkdirSync(join(root, '.gitagent'), { recursive: true });
    writeFileSync(join(root, '.gitagent', '.env'), 'GROQ_API_KEY=gsk_not_a_real_key\n');
    writeFileSync(join(root, '.gitagent', 'agent.yaml'), 'model:\n  provider: groq\n');
    return root;
  }

  /** Point git at a config of our choosing, so the test does not depend on this machine's. */
  async function withGitConfig(contents, fn) {
    const cfg = join(realpathSync(mkdtempSync(join(tmpdir(), 'jra-gitcfg-'))), 'gitconfig');
    writeFileSync(cfg, contents);
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = cfg;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      return await fn();
    } finally {
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
      if (saved.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.s;
    }
  }

  const IDENTITY = '[user]\n\tname = Test\n\temail = test@example.com\n';
  const tracked = (root) => execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

  test('saying yes makes the first commit, without the key or node_modules in it', async () => {
    const root = plainFolder();
    try {
      await withGitConfig(IDENTITY, async () => {
        const state = await ensureRepo(scriptedPrompter(['y']), root);
        assert.equal(state, 'ok');

        const files = tracked(root);
        assert.ok(files.includes('index.html'), 'the project is committed');
        assert.ok(files.includes('.gitagent/agent.yaml'), 'and so is the agent config, which is meant to be');
        assert.ok(!files.some((f) => f.startsWith('node_modules/')), 'node_modules is not');
        assert.ok(!files.includes('.gitagent/.env'), 'and the key is never committed');
        assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /node_modules\//);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('declining, then choosing to go without git, is a knowing choice', async () => {
    const root = plainFolder();
    try {
      const state = await ensureRepo(scriptedPrompter(['n', 'y']), root);
      assert.equal(state, 'no-git');
      assert.equal(existsSync(join(root, '.git')), false, 'nothing was created without a yes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('declining both leaves tasks waiting, and says how to unblock them', async () => {
    const root = plainFolder();
    try {
      const state = await ensureRepo(scriptedPrompter(['n', 'n']), root);
      assert.equal(state, 'blocked');
      assert.equal(existsSync(join(root, '.git')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a git with no identity is explained, not left to fail', async () => {
    const root = plainFolder();
    try {
      await withGitConfig('', async () => {
        // yes to set up, then no to going without — so the result is blocked.
        const state = await ensureRepo(scriptedPrompter(['y', 'n']), root);
        assert.equal(state, 'blocked', 'no commit could be made, and nothing pretends one was');
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a committed repository is not asked anything', async () => {
    const box = sandbox();
    try {
      // A scripted prompter with no answers throws if a question is asked.
      assert.equal(await ensureRepo(scriptedPrompter([]), box.root), 'ok');
    } finally {
      rmSync(box.root, { recursive: true, force: true });
    }
  });
});

describe('the minute, not just the request', () => {
  test('steps are fitted to what is left of the minute, so none is refused', async () => {
    // Reported from a real session: four steps on an 8,000-a-minute key each
    // fitted the limit on their own, but together spent it — the fifth was
    // refused and the run sat out a 50-second wait. The provider reports what
    // is left on every response; the loop now fits to that.
    const { estimateRequest, observe, forgetLive } = await import('../src/budget.js');
    forgetLive();

    const box = sandbox();
    await inRepo(box, async () => {
      const file = join(box.dir, 'agent.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace(
        '  max_tokens: 8192',
        '  max_tokens: 900\n  tokens_per_minute: 8000',
      ));
      writeFileSync(join(box.root, 'README.md'), 'A landing page. '.repeat(900));
      writeFileSync(join(box.root, 'notes.md'), 'More notes here. '.repeat(700));

      // A provider with a real per-minute bucket that refuses what it cannot
      // take, and reports what is left the way Groq does.
      const MINUTE = 8000;
      const WINDOW_MS = 400;
      let spent = 0;
      let windowStart = Date.now();
      let refusals = 0;
      let step = 0;
      const script = [
        { name: 'list_files', input: {} },
        { name: 'read_file', input: { path: 'README.md' } },
        { name: 'read_file', input: { path: 'notes.md' } },
        { name: 'read_file', input: { path: 'README.md' } },
        { name: 'done', input: { summary: 'a landing page, described' } },
      ];

      const call = async (manifest, req) => {
        if (/handing it to someone else/.test(req.system ?? '')) return { text: '{}', toolCalls: [], stopReason: 'end_turn' };
        if (Date.now() - windowStart >= WINDOW_MS) { spent = 0; windowStart = Date.now(); }

        const cost = estimateRequest({ system: req.system, messages: req.messages, tools: req.tools }) + (req.maxTokens ?? 900);
        const resetIn = `${((WINDOW_MS - (Date.now() - windowStart)) / 1000).toFixed(2)}s`;
        if (spent + cost > MINUTE) {
          refusals++;
          const { ProviderError } = await import('../src/provider.js');
          throw new ProviderError('rate limited', { kind: 'rate-limit' });
        }
        spent += cost;
        observe(manifest, { get: (n) => ({
          'x-ratelimit-remaining-tokens': String(MINUTE - spent),
          'x-ratelimit-limit-tokens': String(MINUTE),
          'x-ratelimit-reset-tokens': resetIn,
        })[n] ?? null });

        const next = script[Math.min(step++, script.length - 1)];
        return { text: '', toolCalls: [{ id: `c${step}`, ...next }], stopReason: 'tool_use' };
      };

      const out = await run(['wt does this repo do'], { quiet: true, 'allow-dirty': true }, { call });

      assert.equal(out.status, 'done', 'the task still finishes');
      assert.equal(refusals, 0, 'and no request was sent that the minute could not take');
    });
    forgetLive();
  });

  test('a reply cut off mid tool call is sent again with more room, not fed back broken', async () => {
    // The cap is lowered when the minute is nearly spent, and a lowered cap is
    // exactly what cuts a file write off half-way. That step is sent again —
    // after the minute refills, with the room it ran out of — rather than
    // handing the model its own half-written call as an error.
    const { observe, forgetLive } = await import('../src/budget.js');
    forgetLive();

    const box = sandbox();
    await inRepo(box, async () => {
      const file = join(box.dir, 'agent.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace(
        '  max_tokens: 8192',
        '  max_tokens: 3000\n  tokens_per_minute: 8000',
      ));

      // Most of this minute is already gone when the task starts.
      const manifest = { provider: 'anthropic', model: 'claude-sonnet-4-6' };
      observe(manifest, { get: (n) => ({
        'x-ratelimit-remaining-tokens': '3200',
        // Long enough to outlast the run's own startup (the verify step alone
        // spawns npm), so the first step really does meet a spent minute.
        'x-ratelimit-reset-tokens': '4s',
      })[n] ?? null });

      const sizes = [];
      let dispatchedBroken = false;
      const call = async (_m, req) => {
        if (/handing it to someone else/.test(req.system ?? '')) return { text: '{}', toolCalls: [], stopReason: 'end_turn' };
        sizes.push(req.maxTokens);
        const last = req.messages[req.messages.length - 1];
        if (last?.role === 'tool' && /not valid JSON/.test(last.results?.[0]?.content ?? '')) dispatchedBroken = true;

        if (sizes.length === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'w1', name: 'write_file', input: { __parseError: '{"path":"index.js","content":"export con' } }],
            stopReason: 'length',
          };
        }
        if (sizes.length === 2) {
          return { text: '', toolCalls: [{ id: 'w2', name: 'write_file', input: { path: 'index.js', content: 'export const a = 7;\n' } }], stopReason: 'tool_use' };
        }
        return { text: '', toolCalls: [{ id: 'd', name: 'done', input: { summary: 'written' } }], stopReason: 'tool_use' };
      };

      const out = await run(['write it'], { quiet: true, 'allow-dirty': true }, { call });

      assert.equal(out.status, 'done');
      assert.ok(sizes[1] > sizes[0], `the retry had more room (${sizes[0]} then ${sizes[1]})`);
      assert.equal(dispatchedBroken, false, 'the half-written call was never run');
      assert.match(readFileSync(join(box.root, 'index.js'), 'utf8'), /a = 7/);
    });
    forgetLive();
  });

  test('a retry that can never get more room is sent with the most there is', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const file = join(box.dir, 'agent.yaml');
      // So small a key that a doubled reply can never fit.
      writeFileSync(file, readFileSync(file, 'utf8').replace(
        '  max_tokens: 8192',
        '  max_tokens: 3000\n  tokens_per_minute: 4000',
      ));

      let calls = 0;
      const call = async (_m, req) => {
        if (/handing it to someone else/.test(req.system ?? '')) return { text: '{}', toolCalls: [], stopReason: 'end_turn' };
        calls++;
        if (calls === 1) {
          return { text: '', toolCalls: [{ id: 'w1', name: 'write_file', input: { __parseError: '{"path"' } }], stopReason: 'length' };
        }
        return { text: '', toolCalls: [{ id: 'd', name: 'done', input: { summary: 'ok' } }], stopReason: 'tool_use' };
      };

      const out = await run(['write it'], { quiet: true, 'allow-dirty': true }, { call });
      assert.equal(out.status, 'done', 'it did not give up on a step that fits');
      assert.ok(calls <= 3, `and it did not loop (${calls} calls)`);
    });
  });
});

describe('an agent going round in circles', () => {
  test('re-reading the same part again and again is stopped, not paid for', async () => {
    // Reported from a real session: a file too big for the key was read in
    // slices, each slice was dropped to make room for the next, and the agent
    // re-read them until the day's 200,000 tokens were gone.
    const box = sandbox();
    await inRepo(box, async () => {
      let calls = 0;
      const call = async (_m, req) => {
        if (/handing it to someone else/.test(req.system ?? '')) return { text: '{}', toolCalls: [], stopReason: 'end_turn' };
        calls++;
        return { text: '', toolCalls: [{ id: `r${calls}`, name: 'read_file', input: { path: 'index.js', start_line: 1 } }], stopReason: 'tool_use' };
      };
      const out = await run(['describe the repo'], { quiet: true }, { call });

      assert.equal(out.status, 'stopped');
      assert.equal(out.fatal, 'stuck');
      assert.match(out.reason, /going round in circles/);
      assert.ok(calls <= 3, `stopped at the third identical read, not after ${calls}`);
    });
  });

  test('running the tests again after each edit is checking, not a loop', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const script = [];
      for (let i = 0; i < 4; i++) {
        script.push({ name: 'write_file', input: { path: 'index.js', content: `export const a = ${i};\n` } });
        script.push({ name: 'run_command', input: { command: ['node', '-e', '0'] } });
      }
      script.push({ name: 'done', input: { summary: 'iterated' } });
      let step = 0;
      const call = async (_m, req) => {
        if (/handing it to someone else/.test(req.system ?? '')) return { text: '{}', toolCalls: [], stopReason: 'end_turn' };
        const next = script[Math.min(step++, script.length - 1)];
        return { text: '', toolCalls: [{ id: `c${step}`, ...next }], stopReason: 'tool_use' };
      };
      const out = await run(['iterate on it'], { quiet: true }, { call });
      assert.equal(out.status, 'done', 'the same command four times, with edits between, is fine');
    });
  });

  test('a spent daily allowance ends the run at once', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const { ProviderError } = await import('../src/provider.js');
      let calls = 0;
      const call = async () => {
        calls++;
        throw new ProviderError('Groq rate limit reached for qwen — tokens a day', { kind: 'rate-limit', unit: 'TPD' });
      };
      const out = await run(['anything'], { quiet: true }, { call });

      assert.equal(out.status, 'stopped');
      assert.equal(calls, 1, 'no further attempt asks to be told the same thing');
    });
  });

  test('a lower limit named by the provider is learned, kept, and the step fitted again', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const file = join(box.dir, 'agent.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace('  max_tokens: 8192', '  max_tokens: 900\n  tokens_per_minute: 8000'));
      const { ProviderError } = await import('../src/provider.js');

      let refused = false;
      const call = async (_m, req) => {
        if (/handing it to someone else/.test(req.system ?? '')) return { text: '{}', toolCalls: [], stopReason: 'end_turn' };
        if (!refused) {
          refused = true;
          // Groq counts input on its own: 7,000, under the combined 8,000.
          throw new ProviderError('too large', { kind: 'too-large', unit: 'ITPM', limit: 7000, requested: 7067, inputOnly: true });
        }
        return { text: '', toolCalls: [{ id: 'd', name: 'done', input: { summary: 'fine' } }], stopReason: 'tool_use' };
      };
      const out = await run(['describe it'], { quiet: true, 'allow-dirty': true }, { call });

      assert.equal(out.status, 'done', 'the step went again, fitted, instead of failing the attempt');
      assert.match(readFileSync(file, 'utf8'), /tokens_per_minute: 7000/, 'and the real limit is kept for next time');
    });
  });
});
