import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callModel, parseProviderError, outputCap, forgetCaps, extractJson, ProviderError } from '../src/provider.js';
import { generatePlan, brevity } from '../src/generate.js';
import { isChatModel } from '../src/providers.js';
import { scriptedPrompter } from '../src/prompter.js';
import { chat } from '../src/chat.js';
import { readAgents } from '../src/agents.js';
import { TEMPLATES } from '../src/paths.js';

/**
 * Provider limits, as a free-tier user meets them.
 *
 * The first real /prompt run on a free Groq key died on this, printed raw:
 *
 *   429 {"error":{"message":"Request too large for model `qwen/qwen3.8-27b` in
 *   organization `org_…` service tier `on_demand` on output tokens per minute
 *   (OTPM): Limit 1000, Requested 2581. …
 *
 * Nothing was wrong with the request except how many tokens it asked for, and
 * the interview answers were thrown away with it.
 */

const GROQ_OTPM = JSON.stringify({ error: {
  message: 'Request too large for model `qwen/qwen3.8-27b` in organization `org_01kcfcw7ynfertfbxfz7dzm12y` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 2581. The request\'s expected output tokens exceed the enforced limit; reduce max_tokens (or the request\'s expected output) and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
  type: 'tokens', code: 'rate_limit_exceeded',
} });

const manifest = { provider: 'groq', model: 'qwen/qwen3.8-27b', keyEnv: 'JRA_LIMITS_KEY', baseUrl: null };

function fakeFetch(responses) {
  const bodies = [];
  const fn = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const r = responses[Math.min(bodies.length - 1, responses.length - 1)];
    const headers = { get: (h) => (r.headers ?? {})[h.toLowerCase()] ?? (h.toLowerCase() === 'content-type' ? 'application/json' : null) };
    return {
      ok: r.status === 200, status: r.status, headers,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
      json: async () => r.body,
    };
  };
  fn.bodies = bodies;
  return fn;
}

const okReply = { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'hello' } }] } };

let original;
beforeEach(() => { original = globalThis.fetch; process.env.JRA_LIMITS_KEY = 'gsk_test'; forgetCaps(); });
afterEach(() => { globalThis.fetch = original; delete process.env.JRA_LIMITS_KEY; forgetCaps(); });

describe('reading a provider error', () => {
  test('the Groq free-tier output limit is understood', () => {
    const e = parseProviderError(429, GROQ_OTPM, null);
    assert.equal(e.kind, 'too-large');
    assert.equal(e.unit, 'OTPM');
    assert.equal(e.limit, 1000);
    assert.equal(e.requested, 2581);
    assert.ok(!e.raw.includes('org_'), 'the organisation id is noise on screen');
    assert.ok(!/Upgrade to Dev Tier/.test(e.raw));
  });

  test('"try again in 1m2.5s" becomes a wait', () => {
    const e = parseProviderError(429, JSON.stringify({ error: { message: 'Rate limit reached for model `m` on tokens per minute (TPM): Limit 6000, Used 5900, Requested 400. Please try again in 1m2.5s.' } }), null);
    assert.equal(e.kind, 'rate-limit');
    assert.equal(e.retryAfter, 62500);
    assert.equal(e.limit, 6000);
  });
});

describe('a request that asks for more than the plan allows', () => {
  test('is resent under the limit, and the cap is remembered', async () => {
    const notices = [];
    globalThis.fetch = fakeFetch([{ status: 429, body: GROQ_OTPM }, okReply]);
    const r = await callModel(manifest, { messages: [{ role: 'user', content: 'x' }], maxTokens: 6000, onNotice: (m) => notices.push(m) });

    assert.equal(r.text, 'hello');
    const [first, second] = globalThis.fetch.bodies;
    assert.equal(first.max_tokens, 6000);
    assert.ok(second.max_tokens < 1000, `resent with ${second.max_tokens}`);
    assert.equal(outputCap(manifest), second.max_tokens);
    assert.match(notices.join('\n'), /1,000 output tokens a minute/);

    // The next call starts under the cap instead of failing the same way first.
    globalThis.fetch = fakeFetch([okReply]);
    await callModel(manifest, { messages: [{ role: 'user', content: 'y' }], maxTokens: 4096, onNotice: () => {} });
    assert.ok(globalThis.fetch.bodies[0].max_tokens < 1000);
    assert.equal(globalThis.fetch.bodies.length, 1);
  });

  test('also when streaming', async () => {
    globalThis.fetch = fakeFetch([{ status: 429, body: GROQ_OTPM }, okReply]);
    const seen = [];
    const r = await callModel(manifest, { messages: [{ role: 'user', content: 'x' }], onDelta: (d) => seen.push(d), onNotice: () => {} });
    assert.equal(r.text, 'hello');
    assert.deepEqual(seen, ['hello']);
  });

  test('a limit too small to work in is a readable error, not raw JSON', async () => {
    const tiny = GROQ_OTPM.replace('Limit 1000', 'Limit 200');
    globalThis.fetch = fakeFetch([{ status: 429, body: tiny }]);
    await assert.rejects(
      callModel(manifest, { messages: [{ role: 'user', content: 'x' }], onNotice: () => {} }),
      (e) => {
        assert.ok(e instanceof ProviderError);
        assert.equal(e.kind, 'too-large');
        assert.match(e.message, /allows qwen\/qwen3\.8-27b 200 output tokens a minute/);
        assert.match(e.message, /\/models/);
        assert.ok(!e.message.includes('{"error"'), 'raw JSON on screen');
        assert.ok(!e.message.includes('org_'));
        return true;
      },
    );
    assert.equal(globalThis.fetch.bodies.length, 1, 'it cannot be shrunk, so it is not resent');
  });
});

describe('a rate limit', () => {
  test('a short one is waited out, and the wait is announced', async () => {
    const notices = [];
    globalThis.fetch = fakeFetch([
      { status: 429, body: { error: { message: 'Rate limit reached for model `m` on tokens per minute (TPM): Limit 6000, Used 6000, Requested 300. Please try again in 0.05s.' } } },
      okReply,
    ]);
    const r = await callModel(manifest, { messages: [{ role: 'user', content: 'x' }], onNotice: (m) => notices.push(m) });
    assert.equal(r.text, 'hello');
    assert.match(notices.join('\n'), /rate limited — waiting/);
  });

  test('a long one is reported instead of silently sleeping', async () => {
    globalThis.fetch = fakeFetch([
      { status: 429, body: { error: { message: 'Rate limit reached for model `m` on tokens per day (TPD): Limit 100000, Used 100000, Requested 300. Please try again in 14m3s.' } } },
    ]);
    const started = Date.now();
    await assert.rejects(
      callModel(manifest, { messages: [{ role: 'user', content: 'x' }], onNotice: () => {} }),
      (e) => e.kind === 'rate-limit' && /rate limit reached/.test(e.message) && /14 min/.test(e.message),
    );
    assert.ok(Date.now() - started < 2000);
  });

  test('a refused key says what to do', async () => {
    globalThis.fetch = fakeFetch([{ status: 401, body: { error: { message: 'Invalid API Key' } } }]);
    await assert.rejects(callModel(manifest, { messages: [{ role: 'user', content: 'x' }] }), /refused the API key.*\/key/s);
  });
});

describe('/prompt on a model with a small output limit', () => {
  test('a cut-off plan is asked for again, shorter', async () => {
    const seen = [];
    const plan = { agents: [{ name: 'dev', role: 'Does the work', priority: 1, owns: [], parallel: false, escalates_to: null, terminal: true, fixes_build: true, attempts: 2, soul: '# Dev', rules: '## Must\n- a' }], guards: { protected_paths: [], checkpoint_paths: [] } };
    const call = async (_m, { messages }) => {
      seen.push(messages.at(-1).content);
      return seen.length === 1
        ? { text: '{"agents":[{"name":"dev","soul":"You are a', toolCalls: [], stopReason: 'length' }
        : { text: JSON.stringify(plan), toolCalls: [], stopReason: 'stop' };
    };
    const r = await generatePlan({ goal: 'x', project: 'js', critical: [], shape: 'one' }, manifest, { call });
    assert.ok(r.plan, r.errors?.join('; '));
    assert.match(seen[1], /cut off at the output limit/);
    assert.match(seen[1], /much shorter/);
    assert.doesNotMatch(seen[1], /cannot be used/, 'validation errors about half a JSON object help nobody');
  });

  test('the length guidance only appears when the limit is small', () => {
    assert.equal(brevity(null), '');
    assert.equal(brevity(8000), '');
    assert.match(brevity(900), /about 900 tokens/);
  });

  test('a failed design keeps the answers and offers a way on', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'jra-limits-')));
    const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
    writeFileSync(join(root, 'package.json'), '{"name":"a","scripts":{"test":"node -e 0"}}');
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '--all');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i');
    const dir = join(root, '.gitagent');
    cpSync(TEMPLATES, dir, { recursive: true });
    const mf = join(dir, 'agent.yaml');
    writeFileSync(mf, readFileSync(mf, 'utf8')
      .replace('provider: anthropic', 'provider: groq')
      .replace('name: claude-sonnet-4-6', 'name: qwen/qwen3.8-27b')
      .replace('api_key_env: ANTHROPIC_API_KEY', 'api_key_env: GROQ_API_KEY'));

    const prev = process.cwd();
    const log = console.log;
    const write = process.stdout.write.bind(process.stdout);
    process.env.GROQ_API_KEY = 'gsk_x';
    const models = [];
    const plan = { agents: [{ name: 'dev', role: 'Does the work', priority: 1, owns: [], parallel: false, escalates_to: null, terminal: true, fixes_build: true, attempts: 2, soul: '# Dev', rules: '## Must\n- a' }], guards: { protected_paths: [], checkpoint_paths: [] } };
    try {
      process.chdir(root);
      console.log = () => {};
      process.stdout.write = () => true;
      const call = async (m) => {
        models.push(m.model);
        if (m.model === 'qwen/qwen3.8-27b') throw new ProviderError('Groq allows qwen/qwen3.8-27b 1,000 output tokens a minute', { kind: 'too-large' });
        return { text: JSON.stringify(plan), toolCalls: [] };
      };
      const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '',
        json: async () => ({ data: [{ id: 'qwen/qwen3.8-27b', created: 2 }, { id: 'openai/gpt-oss-120b', created: 1 }] }) });
      const p = scriptedPrompter([
        '/prompt', 'edit code', 'js', '', '', '', '2',   // the interview, once
        '1',                                            // failed → try again
        '4', '1',                                       // failed → a different model → the only other one
        'y', 'y', 'y',                                  // write, replace defaults, same model for all
        '/exit',
      ]);
      await chat([], {}, { prompter: p, call, fetchImpl });
      assert.deepEqual(models, ['qwen/qwen3.8-27b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b']);
      assert.deepEqual(readAgents(dir).map((a) => a.name), ['dev']);
      assert.equal(p.remaining(), 0);
    } finally {
      console.log = log;
      process.stdout.write = write;
      process.chdir(prev);
      delete process.env.GROQ_API_KEY;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('small things the same run turned up', () => {
  test('Groq\'s text-to-speech model is not offered as a coding model', () => {
    assert.equal(isChatModel('canopylabs/orpheus-v1-english'), false);
    assert.equal(isChatModel('qwen/qwen3.8-27b'), true);
  });

  test('a reasoning model\'s <think> block does not hide the JSON', () => {
    assert.deepEqual(extractJson('<think>maybe {"a": 0}? no.</think>\n{"a": 1}'), { a: 1 });
  });
});
