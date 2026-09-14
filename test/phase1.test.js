import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptedPrompter } from '../src/prompter.js';
import { obtainKey, pickModel } from '../src/onboard.js';
import { chat } from '../src/chat.js';
import { smokeTest } from '../src/smoke.js';
import { newAgent, newGuard, checkAll } from '../src/dev.js';
import { readAgents } from '../src/agents.js';
import { readManifest } from '../src/config.js';
import { parseEnv } from '../src/env.js';
import { renderTree } from '../src/tree.js';
import { TEMPLATES } from '../src/paths.js';

/**
 * Phase 1: `npx jr-arch` sets itself up by asking, and then /prompt, /dev and
 * /chat do what they say. Every question is answered by a script, every model
 * listing by a fake fetch, every model call by a scripted model — so none of
 * this needs a key, a network, or a terminal.
 */

const silence = () => {
  const log = console.log;
  const write = process.stdout.write.bind(process.stdout);
  console.log = () => {};
  process.stdout.write = () => true;
  return () => { console.log = log; process.stdout.write = write; };
};

function modelsFetch(ids, { status = 200, host = null } = {}) {
  const seen = [];
  const fn = async (url) => {
    seen.push(String(url));
    if (host && !String(url).includes(host)) throw new Error(`unexpected host in ${url}`);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ data: ids.map((id, i) => ({ id, created: 1000 - i })) }),
      text: async () => '',
    };
  };
  fn.seen = seen;
  return fn;
}

function emptyRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jra-p1-')));
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'node -e 0' } }));
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '--all');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i');
  return root;
}

function setUpRepo(provider = 'groq', keyEnv = 'GROQ_API_KEY', model = 'llama-3.3-70b-versatile') {
  const root = emptyRepo();
  const dir = join(root, '.gitagent');
  cpSync(TEMPLATES, dir, { recursive: true });
  const mf = join(dir, 'agent.yaml');
  writeFileSync(mf, readFileSync(mf, 'utf8')
    .replace('provider: anthropic', `provider: ${provider}`)
    .replace('name: claude-sonnet-4-6', `name: ${model}`)
    .replace('api_key_env: ANTHROPIC_API_KEY', `api_key_env: ${keyEnv}`));
  return { root, dir };
}

async function inRepo(root, fn) {
  const prev = process.cwd();
  const env = { ...process.env };
  process.chdir(root);
  const restore = silence();
  try {
    return await fn();
  } finally {
    restore();
    process.chdir(prev);
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

describe('obtainKey', () => {
  test('a Groq key is recognised, checked, and its models listed', async () => {
    const restore = silence();
    try {
      const fetchImpl = modelsFetch(['llama-3.3-70b-versatile', 'whisper-large-v3'], { host: 'groq.com' });
      const conn = await obtainKey(scriptedPrompter(['gsk_realistic_key_123456']), { fetchImpl });
      assert.equal(conn.provider, 'groq');
      assert.equal(conn.keyEnv, 'GROQ_API_KEY');
      assert.deepEqual(conn.models.map((m) => m.id), ['llama-3.3-70b-versatile'], 'whisper should be filtered');
    } finally { restore(); }
  });

  test('an Anthropic key is sent to Anthropic', async () => {
    const restore = silence();
    try {
      const fetchImpl = modelsFetch(['claude-sonnet-4-6'], { host: 'anthropic.com' });
      const conn = await obtainKey(scriptedPrompter(['sk-ant-api03-xyz']), { fetchImpl });
      assert.equal(conn.provider, 'anthropic');
      assert.match(fetchImpl.seen[0], /api\.anthropic\.com/);
    } finally { restore(); }
  });

  // Found out while setting up, with the prompt still on screen, rather than as
  // a 401 on the first real task.
  test('a rejected key is asked for again', async () => {
    const restore = silence();
    try {
      let n = 0;
      const fetchImpl = async () => ({
        ok: n > 0, status: n++ === 0 ? 401 : 200,
        json: async () => ({ data: [{ id: 'm' }] }), text: async () => '',
      });
      const p = scriptedPrompter(['gsk_wrong_one', 'gsk_right_one']);
      const conn = await obtainKey(p, { fetchImpl });
      assert.equal(conn.key, 'gsk_right_one');
      assert.equal(p.remaining(), 0);
    } finally { restore(); }
  });

  test('an unrecognised key asks which provider it is for', async () => {
    const restore = silence();
    try {
      const fetchImpl = modelsFetch(['m']);
      // 2 = Groq in the choice list
      const conn = await obtainKey(scriptedPrompter(['mystery-key-format', '2']), { fetchImpl });
      assert.equal(conn.provider, 'groq');
    } finally { restore(); }
  });

  test('"ollama" needs no key', async () => {
    const restore = silence();
    try {
      const fetchImpl = modelsFetch(['qwen2.5-coder:14b']);
      const conn = await obtainKey(scriptedPrompter(['ollama', '']), { fetchImpl });
      assert.equal(conn.provider, 'ollama');
      assert.equal(conn.key, '');
    } finally { restore(); }
  });

  test('three bad keys give up rather than looping forever', async () => {
    const restore = silence();
    try {
      const fetchImpl = modelsFetch([], { status: 401 });
      const conn = await obtainKey(scriptedPrompter(['gsk_a', 'gsk_b', 'gsk_c']), { fetchImpl });
      assert.equal(conn, null);
    } finally { restore(); }
  });
});

describe('pickModel', () => {
  test('picks from the list the key returned', async () => {
    const restore = silence();
    try {
      const id = await pickModel(scriptedPrompter(['2']), { provider: 'groq', models: [{ id: 'a' }, { id: 'b' }] });
      assert.equal(id, 'b');
    } finally { restore(); }
  });

  test('with no list, a name is typed', async () => {
    const restore = silence();
    try {
      assert.equal(await pickModel(scriptedPrompter(['my-model']), { provider: 'groq', models: [] }), 'my-model');
    } finally { restore(); }
  });
});

describe('npx jr-arch, first run', () => {
  test('sets everything up by asking, and writes a working scaffold', async () => {
    const root = emptyRepo();
    delete process.env.GROQ_API_KEY;
    await inRepo(root, async () => {
      const p = scriptedPrompter(['gsk_first_run_key_1234567', '1', '3', '/exit']);
      await chat([], {}, { prompter: p, fetchImpl: modelsFetch(['llama-3.3-70b-versatile']) });

      const dir = join(root, '.gitagent');
      const m = readManifest(join(dir, 'agent.yaml'));
      assert.equal(m.provider, 'groq');
      assert.equal(m.model, 'llama-3.3-70b-versatile');
      assert.equal(m.keyEnv, 'GROQ_API_KEY');
      assert.equal(parseEnv(readFileSync(join(dir, '.env'), 'utf8')).GROQ_API_KEY, 'gsk_first_run_key_1234567');
      assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /\.gitagent\/\.env/);
      assert.ok(readAgents(dir).length > 0);
      assert.equal(p.remaining(), 0);
    });
  });

  // The key is on disk the moment setup finishes, so it has to be invisible to
  // git by then, not after a later command gets round to it.
  test('the key never becomes visible to git', async () => {
    const root = emptyRepo();
    delete process.env.GROQ_API_KEY;
    await inRepo(root, async () => {
      await chat([], {}, {
        prompter: scriptedPrompter(['gsk_secret_value_9876543', '1', '3', '/exit']),
        fetchImpl: modelsFetch(['m']),
      });
      const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
      assert.ok(!status.includes('.env'), `git can see the key file:\n${status}`);
    });
  });

  test('with no terminal it explains instead of hanging on a question', async () => {
    const root = emptyRepo();
    await inRepo(root, async () => {
      await assert.rejects(() => chat([], {}, {}), /no terminal to ask you questions/);
    });
  });
});

describe('/prompt', () => {
  const planReply = {
    agents: [
      { name: 'api-dev', role: 'API work', priority: 20, owns: ['src/api/**'], parallel: true,
        escalates_to: 'lead', terminal: false, fixes_build: false, attempts: 2,
        soul: '# API\n\nYou work on the API.', rules: '## Must\n- a\n\n## Must not\n- b\n\n## Hand off when\n- c' },
      { name: 'lead', role: 'Decides', priority: 80, owns: [], parallel: false,
        escalates_to: null, terminal: true, fixes_build: true, attempts: 2,
        soul: '# Lead\n\nYou decide.', rules: '## Must\n- a\n\n## Must not\n- b\n\n## Hand off when\n- c' },
    ],
    guards: { protected_paths: ['secrets/**'], checkpoint_paths: [] },
  };

  test('writes the agents the model designs, and replaces the defaults', async () => {
    const { root, dir } = setUpRepo();
    process.env.GROQ_API_KEY = 'gsk_x';
    await inRepo(root, async () => {
      const call = async () => ({ text: JSON.stringify(planReply), toolCalls: [] });
      const p = scriptedPrompter([
        '/prompt',
        'Build a payments API', '', 'secrets/**', '', '', '1',
        'y', 'y', 'y',
        '/exit',
      ]);
      await chat([], {}, { prompter: p, call, fetchImpl: modelsFetch(['llama-3.3-70b-versatile']) });

      assert.deepEqual(readAgents(dir).map((a) => a.name), ['api-dev', 'lead']);
      assert.ok(existsSync(join(dir, 'hooks', 'project.yaml')));
      assert.equal(p.remaining(), 0);
    });
  });

  test('declining the preview writes nothing', async () => {
    const { root, dir } = setUpRepo();
    process.env.GROQ_API_KEY = 'gsk_x';
    await inRepo(root, async () => {
      const before = readAgents(dir).map((a) => a.name);
      const call = async () => ({ text: JSON.stringify(planReply), toolCalls: [] });
      await chat([], {}, {
        prompter: scriptedPrompter(['/prompt', 'x', '', '', '', '', '1', 'n', '/exit']),
        call, fetchImpl: modelsFetch(['m']),
      });
      assert.deepEqual(readAgents(dir).map((a) => a.name), before);
      assert.ok(!existsSync(join(dir, 'hooks', 'project.yaml')));
    });
  });

  // "Do you have a separate key for it" — a second provider for one agent.
  test('an agent can be given its own provider and key', async () => {
    const { root, dir } = setUpRepo();
    process.env.GROQ_API_KEY = 'gsk_x';
    delete process.env.ANTHROPIC_API_KEY;
    await inRepo(root, async () => {
      const call = async () => ({ text: JSON.stringify(planReply), toolCalls: [] });
      const fetchImpl = async (url) => ({
        ok: true, status: 200, text: async () => '',
        json: async () => ({ data: String(url).includes('anthropic') ? [{ id: 'claude-opus-4-1' }] : [{ id: 'llama-3.3-70b-versatile' }] }),
      });
      await chat([], {}, {
        prompter: scriptedPrompter([
          '/prompt', 'x', '', '', '', '', '1', 'y', 'y',
          'n',                           // not the same model for everyone
          '1',                           // api-dev: keep the default
          '2',                           // lead: a different provider
          'sk-ant-api03-separate-key',   // its key
          '1',                           // its model
          '/exit',
        ]),
        call, fetchImpl,
      });

      const text = readFileSync(join(dir, 'agent.yaml'), 'utf8');
      assert.match(text, /^tiers:/m);
      assert.match(text, /lead:\n\s+model:\n\s+provider: anthropic/);
      assert.equal(parseEnv(readFileSync(join(dir, '.env'), 'utf8')).ANTHROPIC_API_KEY, 'sk-ant-api03-separate-key');
    });
  });
});

describe('/dev', () => {
  test('/new scaffolds an agent the loop can read', () => {
    const { root, dir } = setUpRepo();
    newAgent('reviewer', { dir });
    const a = readAgents(dir).find((x) => x.name === 'reviewer');
    assert.ok(a);
    assert.equal(a.priority, 50);
    assert.equal(a.attempts, 2);
    assert.throws(() => newAgent('reviewer', { dir }), /already exists/);
    assert.throws(() => newAgent('../bad', { dir }), /not a usable/);
    rmSync(root, { recursive: true, force: true });
  });

  test('/guard scaffolds a guard file that parses', () => {
    const { root, dir } = setUpRepo();
    newGuard('strict', { dir });
    assert.ok(existsSync(join(dir, 'hooks', 'strict.yaml')));
    assert.equal(checkAll({ dir }).errors.length, 0);
    rmSync(root, { recursive: true, force: true });
  });

  test('/check catches an escalation to an agent that is not installed', () => {
    const { root, dir } = setUpRepo();
    newAgent('broken', { dir });
    const soul = join(dir, 'agents', 'broken', 'SOUL.md');
    writeFileSync(soul, readFileSync(soul, 'utf8').replace('# escalates_to: other-agent', 'escalates_to: nobody'));
    assert.match(checkAll({ dir }).errors.join(), /nobody/);
    rmSync(root, { recursive: true, force: true });
  });

  test('/check catches a loop', () => {
    const { root, dir } = setUpRepo();
    rmSync(join(dir, 'agents'), { recursive: true, force: true });
    for (const [n, to] of [['a', 'b'], ['b', 'a']]) {
      mkdirSync(join(dir, 'agents', `agent-${n}`), { recursive: true });
      writeFileSync(join(dir, 'agents', `agent-${n}`, 'SOUL.md'), `---\nname: agent-${n}\nescalates_to: agent-${to}\n---\n\n# x\n`);
    }
    assert.match(checkAll({ dir }).errors.join(), /escalation loop/);
    rmSync(root, { recursive: true, force: true });
  });

  test('/check flags a scaffold still full of TODOs', () => {
    const { root, dir } = setUpRepo();
    newAgent('fresh', { dir });
    newGuard('fresh-guard', { dir });
    const w = checkAll({ dir }).warnings.join('\n');
    assert.match(w, /fresh: SOUL.md still has TODO/);
    assert.match(w, /fresh-guard\.yaml: still has TODO/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('smoke test', () => {
  const doneCall = async () => ({ text: '', toolCalls: [{ id: 't', name: 'done', input: { summary: 'smoke ok' } }] });

  test('passes an agent that works', async () => {
    const { root, dir } = setUpRepo();
    process.env.GROQ_API_KEY = 'gsk_x';
    try {
      const r = await smokeTest('junior-dev', { dir, call: doneCall, fetchImpl: modelsFetch(['llama-3.3-70b-versatile']) });
      assert.equal(r.ok, true, JSON.stringify(r.results));
      assert.deepEqual(r.results.filter((x) => !x.warn).map((x) => x.check), ['files', 'routing', 'guards', 'key', 'model', 'tools']);
    } finally {
      delete process.env.GROQ_API_KEY;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails on a missing key before spending a call', async () => {
    const { root, dir } = setUpRepo();
    delete process.env.GROQ_API_KEY;
    let called = false;
    const r = await smokeTest('junior-dev', { dir, call: async () => { called = true; return doneCall(); } });
    assert.equal(r.ok, false);
    assert.equal(r.results.at(-1).check, 'key');
    assert.equal(called, false);
    rmSync(root, { recursive: true, force: true });
  });

  test('fails when the key cannot see the model', async () => {
    const { root, dir } = setUpRepo();
    process.env.GROQ_API_KEY = 'gsk_x';
    try {
      const r = await smokeTest('junior-dev', { dir, call: doneCall, fetchImpl: modelsFetch(['some-other-model']) });
      assert.equal(r.ok, false);
      assert.equal(r.results.at(-1).check, 'model');
    } finally {
      delete process.env.GROQ_API_KEY;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A model that answers in prose cannot drive an agent — the thing to know
  // before a real task, not during one.
  test('fails a model that will not call tools', async () => {
    const { root, dir } = setUpRepo();
    process.env.GROQ_API_KEY = 'gsk_x';
    try {
      const prose = async () => ({ text: 'Sure! I would call done.', toolCalls: [] });
      const r = await smokeTest('junior-dev', { dir, call: prose, fetchImpl: modelsFetch(['llama-3.3-70b-versatile']) });
      assert.equal(r.ok, false);
      assert.equal(r.results.at(-1).check, 'tools');
    } finally {
      delete process.env.GROQ_API_KEY;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--offline checks files and keys without any network', async () => {
    const { root, dir } = setUpRepo();
    process.env.GROQ_API_KEY = 'gsk_x';
    try {
      const fetchImpl = async () => { throw new Error('network used'); };
      const r = await smokeTest('junior-dev', { dir, fetchImpl, skipNetwork: true });
      assert.equal(r.ok, true);
      assert.ok(!r.results.some((x) => x.check === 'tools'));
    } finally {
      delete process.env.GROQ_API_KEY;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unknown agent fails clearly', async () => {
    const { root, dir } = setUpRepo();
    const r = await smokeTest('ghost', { dir });
    assert.equal(r.ok, false);
    assert.match(r.results[0].detail, /no agent "ghost"/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('the tree', () => {
  test('annotates agents with their role, and marks the key file', () => {
    const { root, dir } = setUpRepo();
    writeFileSync(join(dir, '.env'), 'GROQ_API_KEY=x\n');
    const lines = renderTree(dir).join('\n');
    assert.match(lines, /junior-dev\/.*Scoped, single-concern implementation/);
    assert.match(lines, /\.env.*gitignored/);
    assert.ok(!lines.includes('.session'), 'transcripts should be hidden');
    rmSync(root, { recursive: true, force: true });
  });
});
