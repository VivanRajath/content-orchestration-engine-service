import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, listModels, baseUrlFor, wireFor, KeyRejected } from '../src/providers.js';
import { parseProviderError, isFatalProviderError, ProviderError, readOpenAIStream } from '../src/provider.js';
import { envTemplate, providerOfVar } from '../src/env.js';

/**
 * Google Gemini, through Google's OpenAI-compatible endpoint. It speaks the
 * same wire format as the others but differs in the details that decide
 * whether a key is recognised and whether an error reads right: `AIza` keys,
 * `models/`-prefixed ids, a bad key reported as 400, errors wrapped in an
 * array, and a daily quota named only in the quota id.
 *
 * None of this has met the live API — the shapes are Google's documented ones.
 */

// Assembled at runtime so no realistic-looking key sits in the repo.
const KEY = ['AI', 'za', 'Sy', 'x'.repeat(33)].join('');

function fakeFetch(respond) {
  const seen = [];
  const fn = async (url, opts = {}) => {
    seen.push({ url: String(url), headers: opts.headers ?? {} });
    const r = respond(String(url), opts);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => text,
      headers: { get: () => null },
    };
  };
  fn.seen = seen;
  return fn;
}

describe('recognising a Gemini key', () => {
  test('an AIza key is Gemini', () => {
    assert.equal(detectProvider(KEY), 'gemini');
    assert.equal(detectProvider(`  ${KEY}\n`), 'gemini');
  });

  test('it goes to Google, over the OpenAI wire format', () => {
    assert.equal(baseUrlFor('gemini'), 'https://generativelanguage.googleapis.com/v1beta/openai');
    assert.equal(wireFor('gemini'), 'openai');
  });

  test('the .env template has a place for it', () => {
    assert.match(envTemplate(), /^# GEMINI_API_KEY=/m);
  });

  test('a second Gemini key, or one under GOOGLE_API_KEY, is still Gemini', () => {
    assert.equal(providerOfVar('GEMINI_API_KEY_2', 'x'), 'gemini');
    assert.equal(providerOfVar('GOOGLE_API_KEY', KEY), 'gemini');
  });
});

describe('listing Gemini models', () => {
  const models = {
    object: 'list',
    data: [
      { id: 'models/gemini-2.5-flash', object: 'model', owned_by: 'google' },
      { id: 'models/gemini-2.5-pro', object: 'model', owned_by: 'google' },
      { id: 'models/text-embedding-004', object: 'model', owned_by: 'google' },
      { id: 'models/gemini-embedding-001', object: 'model', owned_by: 'google' },
      { id: 'models/imagen-3.0-generate-002', object: 'model', owned_by: 'google' },
      { id: 'models/veo-2.0-generate-001', object: 'model', owned_by: 'google' },
      { id: 'models/aqa', object: 'model', owned_by: 'google' },
      { id: 'models/gemini-2.5-flash-preview-tts', object: 'model', owned_by: 'google' },
    ],
  };

  test('asks Google with a Bearer key and returns bare chat model names', async () => {
    const f = fakeFetch(() => ({ status: 200, body: models }));
    const got = await listModels('gemini', KEY, { fetchImpl: f });
    assert.equal(f.seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/models');
    assert.equal(f.seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(got.map((m) => m.id).sort(), ['gemini-2.5-flash', 'gemini-2.5-pro']);
  });

  // Google answers a bad key with 400, not 401. Read as a server error, it
  // told the user to try again later with the same dead key.
  test('a 400 API_KEY_INVALID is a rejected key', async () => {
    const f = fakeFetch(() => ({
      status: 400,
      body: [{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }],
    }));
    await assert.rejects(listModels('gemini', KEY, { fetchImpl: f }), KeyRejected);
  });

  test('any other 400 is still an ordinary error', async () => {
    const f = fakeFetch(() => ({ status: 400, body: { error: { message: 'bad request' } } }));
    await assert.rejects(listModels('gemini', KEY, { fetchImpl: f }), (e) => !(e instanceof KeyRejected));
  });
});

describe('reading Gemini errors', () => {
  test('an error wrapped in an array is read, not dumped raw', () => {
    const text = JSON.stringify([{ error: { code: 404, message: 'models/nope is not found for API version v1beta', status: 'NOT_FOUND' } }]);
    const info = parseProviderError(404, text, null);
    assert.equal(info.kind, 'model');
    assert.match(info.raw, /is not found/);
  });

  test('a bad key mid-run is an auth failure, and fatal', () => {
    const text = JSON.stringify([{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }]);
    const info = parseProviderError(400, text, null);
    assert.equal(info.kind, 'auth');
    assert.equal(isFatalProviderError(new ProviderError('x', info)), true);
  });

  const quota = (quotaId) => JSON.stringify([{
    error: {
      code: 429,
      message: 'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 50\nPlease retry in 35.5s.',
      status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] }],
    },
  }]);

  // The daily quota is named only in the quota id. Missing it meant waiting
  // out a "35s" retry, then spending another request to hear the same thing.
  test('a spent daily quota is fatal', () => {
    const info = parseProviderError(429, quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier'), null);
    assert.equal(info.kind, 'rate-limit');
    assert.equal(info.unit, 'RPD');
    assert.equal(isFatalProviderError(new ProviderError('x', info)), true);
  });

  test('a per-minute quota is waited out, for as long as Google says', () => {
    const info = parseProviderError(429, quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'), null);
    assert.equal(info.kind, 'rate-limit');
    assert.equal(info.unit, null);
    assert.equal(info.retryAfter, 35500);
    assert.equal(isFatalProviderError(new ProviderError('x', info)), false);
  });
});

describe('streamed tool calls without an index', () => {
  async function* events(list) { for (const e of list) yield e; }

  // Gemini sends each call whole and may leave out `index`. Reading every call
  // as index 0 glued two calls' arguments into one unparseable string.
  test('two whole calls stay two calls', async () => {
    const got = await readOpenAIStream(events([
      { choices: [{ delta: { tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 'b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.js"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]));
    assert.deepEqual(got.toolCalls.map((c) => [c.id, c.name, c.input.path]), [['a', 'read_file', 'a.js'], ['b', 'read_file', 'b.js']]);
  });

  test('an indexed call streamed in pieces still assembles', async () => {
    const got = await readOpenAIStream(events([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.js"}' } }] } }] },
    ]));
    assert.equal(got.toolCalls.length, 1);
    assert.equal(got.toolCalls[0].input.path, 'a.js');
  });

  test('an unindexed call streamed in pieces still assembles', async () => {
    const got = await readOpenAIStream(events([
      { choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: 'th":"a.js"}' } }] } }] },
    ]));
    assert.equal(got.toolCalls.length, 1);
    assert.equal(got.toolCalls[0].input.path, 'a.js');
  });
});
