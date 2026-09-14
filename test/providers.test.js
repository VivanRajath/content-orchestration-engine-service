import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, listModels, isChatModel, baseUrlFor, KeyRejected, PROVIDERS } from '../src/providers.js';
import { callModel } from '../src/provider.js';

/**
 * Recognising a key, listing what it can reach, and sending it only to the
 * provider it belongs to.
 */

/** A fetch that answers from a table, and records every URL it was asked for. */
function fakeFetch(respond) {
  const seen = [];
  const fn = async (url, opts = {}) => {
    seen.push({ url: String(url), headers: opts.headers ?? {}, body: opts.body });
    const r = respond(String(url), opts);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ''),
      headers: { get: () => null },
    };
  };
  fn.seen = seen;
  return fn;
}

describe('detectProvider', () => {
  const cases = [
    ['sk-ant-api03-abc', 'anthropic'],
    ['gsk_abc123', 'groq'],
    ['sk-or-v1-abc', 'openrouter'],
    ['xai-abc', 'xai'],
    ['sk-proj-abc', 'openai'],
    ['sk-abc', 'openai'],
  ];
  for (const [key, expected] of cases) {
    test(`${key.slice(0, 8)}… is ${expected}`, () => {
      assert.equal(detectProvider(key), expected);
    });
  }

  // `sk-` is also the start of an Anthropic and an OpenRouter key, so the
  // specific prefixes have to win or both would be misread as OpenAI.
  test('specific prefixes win over the generic sk-', () => {
    assert.equal(detectProvider('sk-ant-x'), 'anthropic');
    assert.equal(detectProvider('sk-or-x'), 'openrouter');
  });

  test('an unrecognised key is null, not a guess', () => {
    assert.equal(detectProvider('something-else-entirely'), null);
    assert.equal(detectProvider(''), null);
    assert.equal(detectProvider(null), null);
  });

  test('surrounding whitespace from a paste is ignored', () => {
    assert.equal(detectProvider('  gsk_abc\n'), 'groq');
  });
});

describe('isChatModel', () => {
  // None of these can call a tool, so offering one as the model for a coding
  // agent is offering a guaranteed failure.
  for (const id of ['whisper-large-v3', 'playai-tts', 'text-embedding-3-small', 'meta-llama/llama-guard-4-12b', 'dall-e-3', 'omni-moderation-latest']) {
    test(`${id} is filtered out`, () => assert.equal(isChatModel(id), false));
  }
  for (const id of ['llama-3.3-70b-versatile', 'claude-sonnet-4-6', 'gpt-4o', 'openai/gpt-oss-120b', 'qwen/qwen3-32b']) {
    test(`${id} is kept`, () => assert.equal(isChatModel(id), true));
  }
});

describe('listModels', () => {
  test('reads the OpenAI-shaped list Groq returns', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: { data: [
      { id: 'llama-3.3-70b-versatile', created: 100 },
      { id: 'whisper-large-v3', created: 999 },
      { id: 'openai/gpt-oss-120b', created: 300 },
    ] } }));
    const models = await listModels('groq', 'gsk_x', { fetchImpl });

    assert.deepEqual(models.map((m) => m.id), ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']);
    assert.equal(fetchImpl.seen[0].url, 'https://api.groq.com/openai/v1/models');
    assert.equal(fetchImpl.seen[0].headers.authorization, 'Bearer gsk_x');
  });

  test('reads the Anthropic list, with its own headers and pagination', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: { data: [
      { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
      { id: 'claude-opus-4-1', display_name: 'Claude Opus 4.1', created_at: '2025-08-05T00:00:00Z' },
    ] } }));
    const models = await listModels('anthropic', 'sk-ant-x', { fetchImpl });

    assert.equal(models[0].id, 'claude-haiku-4-5', 'newest first');
    assert.equal(models[0].label, 'Claude Haiku 4.5');
    const req = fetchImpl.seen[0];
    assert.match(req.url, /^https:\/\/api\.anthropic\.com\/v1\/models\?limit=1000$/);
    assert.equal(req.headers['x-api-key'], 'sk-ant-x');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    assert.equal(req.headers.authorization, undefined, 'Anthropic does not take a bearer token');
  });

  // Listing models doubles as the key check; a rejected key has to be
  // distinguishable from a network problem so onboarding can say which.
  test('a 401 is a rejected key', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 401, body: { error: 'invalid' } }));
    await assert.rejects(() => listModels('groq', 'gsk_bad', { fetchImpl }), KeyRejected);
  });

  test('a 500 is an error, not a rejected key', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 500, body: 'down' }));
    await assert.rejects(
      () => listModels('groq', 'gsk_x', { fetchImpl }),
      (e) => !(e instanceof KeyRejected) && /500/.test(e.message),
    );
  });

  test('an unreachable provider says so', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    await assert.rejects(() => listModels('ollama', '', { fetchImpl }), /Could not reach/);
  });

  test('ollama is asked without a key', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: { data: [{ id: 'qwen2.5-coder:14b' }] } }));
    await listModels('ollama', '', { fetchImpl });
    assert.equal(fetchImpl.seen[0].headers.authorization, undefined);
  });

  test('openai-compatible uses the base URL it is given', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: { data: [{ id: 'm' }] } }));
    await listModels('openai-compatible', 'k', { fetchImpl, baseUrl: 'https://api.together.xyz/v1/' });
    assert.equal(fetchImpl.seen[0].url, 'https://api.together.xyz/v1/models');
  });
});

describe('the key goes only to its own provider', () => {
  test('every provider with a default has its own endpoint', () => {
    assert.equal(baseUrlFor('groq'), 'https://api.groq.com/openai/v1');
    assert.equal(baseUrlFor('openrouter'), 'https://openrouter.ai/api/v1');
    assert.equal(baseUrlFor('anthropic'), 'https://api.anthropic.com');
    assert.equal(baseUrlFor('openai-compatible'), null, 'no default — it must be told');
  });

  // The request layer used to fall back to api.openai.com for everything that
  // was not Anthropic, so a Groq key with no base_url was sent to OpenAI.
  test('a groq manifest with no base_url calls groq, not openai', async () => {
    const original = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) };
    };
    process.env.JRA_TEST_GROQ = 'gsk_test';
    try {
      await callModel(
        { provider: 'groq', model: 'llama-3.3-70b-versatile', keyEnv: 'JRA_TEST_GROQ', baseUrl: null },
        { messages: [{ role: 'user', content: 'x' }] },
      );
    } finally {
      globalThis.fetch = original;
      delete process.env.JRA_TEST_GROQ;
    }
    assert.equal(seen[0], 'https://api.groq.com/openai/v1/chat/completions');
    assert.ok(!seen.some((u) => u.includes('openai.com/v1')), 'the groq key reached openai');
  });

  test('openai-compatible with no base_url refuses rather than guessing', async () => {
    process.env.JRA_TEST_K = 'k';
    try {
      await assert.rejects(
        () => callModel({ provider: 'openai-compatible', model: 'm', keyEnv: 'JRA_TEST_K', baseUrl: null },
          { messages: [{ role: 'user', content: 'x' }] }),
        /No base_url/,
      );
    } finally {
      delete process.env.JRA_TEST_K;
    }
  });

  test('every provider names a key variable', () => {
    for (const [id, spec] of Object.entries(PROVIDERS)) {
      assert.match(spec.keyEnv, /^[A-Z][A-Z0-9_]*$/, `${id} has no usable keyEnv`);
    }
  });
});
