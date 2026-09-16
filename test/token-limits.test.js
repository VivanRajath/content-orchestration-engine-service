import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEMPLATES } from '../src/paths.js';
import {
  patchTierModel, upsertScalar, readManifest, modelFor,
  setTierMaxTokens, clearTierMaxTokens, setModelMaxTokens,
} from '../src/config.js';
import { parseRateLimits, humanReset, probeLimits, suggestedCap, agentCaps } from '../src/limits.js';

const MANIFEST = readFileSync(join(TEMPLATES, 'agent.yaml'), 'utf8');

/** A fetch that records what it was asked and answers with the given headers. */
function fakeFetch({ status = 200, headers = {}, body = {} } = {}) {
  const seen = [];
  const fn = async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method, headers: opts.headers ?? {}, body: opts.body });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  fn.seen = seen;
  return fn;
}

async function inTempRepo(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jra-limits-')));
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, '.gitagent'));
  writeFileSync(join(dir, '.gitagent', 'agent.yaml'), MANIFEST);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await fn(dir, join(dir, '.gitagent', 'agent.yaml'));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('reading a key’s limits from the provider', () => {
  test('parses the OpenAI-shaped headers Groq, OpenAI and xAI send', () => {
    const limits = parseRateLimits({
      get: (n) => ({
        'x-ratelimit-limit-requests': '14400',
        'x-ratelimit-remaining-requests': '14370',
        'x-ratelimit-reset-requests': '2m59.56s',
        'x-ratelimit-limit-tokens': '18000',
        'x-ratelimit-remaining-tokens': '17600',
        'x-ratelimit-reset-tokens': '30s',
      }[n] ?? null),
    });

    assert.equal(limits.found, true);
    const requests = limits.rows.find((r) => r.key === 'requests');
    assert.equal(requests.limit, 14400);
    assert.equal(requests.remaining, 14370);
    assert.equal(requests.reset, 'in 3 min');
    assert.equal(limits.rows.find((r) => r.key === 'tokens').limit, 18000);
  });

  test('parses Anthropic’s headers, which name the parts the other way round', () => {
    const reset = new Date(Date.now() + 45000).toISOString();
    const limits = parseRateLimits({
      get: (n) => ({
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '49',
        'anthropic-ratelimit-input-tokens-limit': '40000',
        'anthropic-ratelimit-output-tokens-limit': '8000',
        'anthropic-ratelimit-output-tokens-remaining': '8000',
        'anthropic-ratelimit-output-tokens-reset': reset,
      }[n] ?? null),
    });

    assert.equal(limits.found, true);
    assert.equal(limits.rows.find((r) => r.key === 'input').limit, 40000);
    const output = limits.rows.find((r) => r.key === 'output');
    assert.equal(output.limit, 8000);
    assert.match(output.reset, /^in \d+s$/, 'an absolute timestamp is shown as a wait');
  });

  test('a provider that reports nothing is a normal answer, not an error', () => {
    assert.deepEqual(parseRateLimits(null), { found: false, rows: [], retryAfter: null });
    assert.equal(parseRateLimits({ get: () => null }).found, false);
  });

  test('a throttled key still reports when it frees up', () => {
    const limits = parseRateLimits({ get: (n) => (n === 'retry-after' ? '60' : null) });
    assert.equal(limits.retryAfter, 'in 1 min');
  });

  test('resets are read as seconds, durations, or a timestamp', () => {
    assert.equal(humanReset('90'), 'in 2 min');
    assert.equal(humanReset('1m30s'), 'in 2 min');
    assert.equal(humanReset('500ms'), 'in under a second');
    assert.equal(humanReset(new Date(Date.now() - 5000).toISOString()), 'now');
    assert.equal(humanReset(''), null);
  });
});

describe('probing for limits', () => {
  test('asks the chat endpoint for a single token, and reads the headers', async () => {
    const fetchImpl = fakeFetch({ headers: { 'x-ratelimit-limit-tokens': '6000' } });
    const limits = await probeLimits({ provider: 'groq', model: 'llama-3.3-70b-versatile', key: 'gsk_x', fetchImpl });

    assert.equal(limits.found, true);
    assert.equal(limits.rows[0].limit, 6000);
    const req = fetchImpl.seen[0];
    assert.equal(req.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(req.method, 'POST');
    assert.equal(JSON.parse(req.body).max_tokens, 1, 'a probe must not generate a real reply');
  });

  test('uses the Anthropic endpoint and its auth header', async () => {
    const fetchImpl = fakeFetch({ headers: { 'anthropic-ratelimit-output-tokens-limit': '8000' } });
    await probeLimits({ provider: 'anthropic', model: 'claude-sonnet-4-6', key: 'sk-ant-x', fetchImpl });

    const req = fetchImpl.seen[0];
    assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(req.headers['x-api-key'], 'sk-ant-x');
    assert.equal(req.headers.authorization, undefined);
  });

  test('an error response still carries the limits, so a throttled key reports them', async () => {
    const fetchImpl = fakeFetch({
      status: 429,
      headers: { 'x-ratelimit-limit-tokens': '6000', 'x-ratelimit-remaining-tokens': '0', 'retry-after': '30' },
    });
    const limits = await probeLimits({ provider: 'groq', model: 'm', key: 'gsk_x', fetchImpl });

    assert.equal(limits.found, true);
    assert.equal(limits.rows[0].remaining, 0);
    assert.equal(limits.retryAfter, 'in 30s');
  });

  test('a local provider is never asked, and says why', async () => {
    const fetchImpl = async () => { throw new Error('network used'); };
    const limits = await probeLimits({ provider: 'ollama', model: 'qwen2.5-coder:14b', fetchImpl });
    assert.equal(limits.found, false);
    assert.match(limits.note, /locally/);
  });

  test('an unreachable provider is reported, not thrown', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const limits = await probeLimits({ provider: 'groq', model: 'm', key: 'gsk_x', fetchImpl });
    assert.equal(limits.found, false);
    assert.match(limits.note, /Could not reach/);
  });

  test('a suggested cap sits under the output allowance, never above it', () => {
    const limits = { rows: [{ key: 'output', limit: 1000 }] };
    assert.equal(suggestedCap(limits), 900);
    // A combined limit counts the prompt too, so a reply may claim half of it.
    assert.equal(suggestedCap({ rows: [{ key: 'tokens', limit: 6000 }] }), 3000);
    assert.equal(suggestedCap({ rows: [{ key: 'output', limit: 1000 }, { key: 'tokens', limit: 6000 }] }), 900,
      'an output-specific limit is the better answer when both are reported');
    assert.equal(suggestedCap(null), null);
    assert.equal(suggestedCap({ rows: [{ key: 'requests', limit: 60 }] }), null, 'a request limit is not a token budget');
  });
});

describe('setting a reply cap per agent', () => {
  test('creates the tiers block when the manifest has none', () => {
    const { text, changed } = patchTierModel(MANIFEST, 'junior-dev', 'max_tokens', 2048);
    assert.equal(changed, true);
    assert.match(text, /^tiers:\n {2}junior-dev:\n {4}model:\n {6}max_tokens: 2048$/m);
    // The commented-out example in the shipped manifest must not be written into.
    assert.match(text, /^# tiers:$/m);
  });

  test('merges into an existing tier without touching its other settings', () => {
    const rich = `${MANIFEST}\ntiers:\n  junior-dev:\n    model:\n      provider: groq   # cheap and fast\n      name: llama\n`;
    const { text } = patchTierModel(rich, 'junior-dev', 'max_tokens', 1500);

    assert.match(text, /provider: groq {3}# cheap and fast/, 'comments in the block survive');
    assert.match(text, /name: llama/);
    assert.match(text, /max_tokens: 1500/);
  });

  test('replaces a cap that is already there rather than adding a second one', () => {
    const once = patchTierModel(MANIFEST, 'junior-dev', 'max_tokens', 2048).text;
    const twice = patchTierModel(once, 'junior-dev', 'max_tokens', 512).text;
    assert.equal(twice.match(/max_tokens: /g).length, 2, 'one under model:, one under tiers:');
    assert.match(twice, /max_tokens: 512/);
  });

  test('a second agent joins the block instead of replacing it', () => {
    let text = patchTierModel(MANIFEST, 'junior-dev', 'max_tokens', 2048).text;
    text = patchTierModel(text, 'senior-dev', 'max_tokens', 8000).text;
    assert.match(text, /^ {2}junior-dev:/m);
    assert.match(text, /^ {2}senior-dev:/m);
  });

  test('removing a cap takes its empty parents with it', () => {
    let text = patchTierModel(MANIFEST, 'junior-dev', 'max_tokens', 2048).text;
    text = patchTierModel(text, 'senior-dev', 'max_tokens', 8000).text;

    const dropped = patchTierModel(text, 'junior-dev', 'max_tokens', null);
    assert.equal(dropped.changed, true);
    // Anchored: the shipped manifest mentions both names in a commented example.
    assert.doesNotMatch(dropped.text, /^ {2}junior-dev:/m, 'an agent with nothing left in it is removed');
    assert.match(dropped.text, /^ {2}senior-dev:/m);

    const empty = patchTierModel(dropped.text, 'senior-dev', 'max_tokens', null);
    assert.doesNotMatch(empty.text, /^tiers:/m, 'the last one takes the block with it');
    assert.match(empty.text, /^routing:/m, 'and nothing else moved');
  });

  test('removing a cap that was never set changes nothing', () => {
    assert.deepEqual(patchTierModel(MANIFEST, 'ghost', 'max_tokens', null), { text: MANIFEST, changed: false });
  });

  test('the default cap is replaced in place, or added when absent', () => {
    assert.match(upsertScalar(MANIFEST, 'model', 'max_tokens', 1234), /^ {2}max_tokens: 1234$/m);

    const without = MANIFEST.replace(/^ {2}max_tokens: .*\n/m, '');
    const added = upsertScalar(without, 'model', 'max_tokens', 777);
    assert.match(added, /^ {2}max_tokens: 777$/m);
    assert.match(added, /^ {2}temperature: 0\.2$/m, 'the rest of the model block is untouched');
    assert.match(added, /^hooks: hooks\/hooks\.yaml$/m);
  });
});

describe('what the run loop reads back', () => {
  test('an agent runs under its own cap, and the others inherit', async () => {
    await inTempRepo(async (_dir, file) => {
      setModelMaxTokens(4096, file);
      setTierMaxTokens('junior-dev', 900, file);

      const manifest = readManifest(file);
      assert.equal(manifest.maxTokens, 4096);
      assert.equal(modelFor(manifest, 'junior-dev').maxTokens, 900);
      assert.equal(modelFor(manifest, 'senior-dev').maxTokens, 4096);
      // A cap must never drag the rest of the model config with it.
      assert.equal(modelFor(manifest, 'junior-dev').provider, manifest.provider);
      assert.equal(modelFor(manifest, 'junior-dev').model, manifest.model);
    });
  });

  test('clearing a cap puts the agent back on the default', async () => {
    await inTempRepo(async (_dir, file) => {
      setTierMaxTokens('junior-dev', 900, file);
      assert.equal(clearTierMaxTokens('junior-dev', file), true);
      assert.equal(clearTierMaxTokens('junior-dev', file), false, 'and says so when there was nothing to clear');
      assert.equal(modelFor(readManifest(file), 'junior-dev').maxTokens, readManifest(file).maxTokens);
    });
  });

  test('the caps table names every agent, marking the inherited ones', async () => {
    await inTempRepo(async (_dir, file) => {
      setTierMaxTokens('junior-dev', 900, file);
      const manifest = readManifest(file);
      const rows = agentCaps(manifest, [{ name: 'junior-dev' }, { name: 'senior-dev' }]);

      assert.deepEqual(rows.map((r) => [r.name, r.maxTokens, r.inherited]), [
        ['junior-dev', 900, false],
        ['senior-dev', manifest.maxTokens, true],
      ]);
    });
  });
});

describe('what a small cap must not break', () => {
  test('a reply cut off before it produced text is still a valid turn', async () => {
    // A low max_tokens makes this ordinary: the model is stopped at the limit
    // before writing anything, the loop nudges it, and the nudge carries the
    // empty turn back to the provider. Anthropic rejects an empty assistant
    // message, so the whole run used to die on a cap the user had just set.
    let sent = null;
    const fetchImpl = async (_url, opts) => {
      sent = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      };
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    process.env.JRA_TEST_KEY = 'x';
    try {
      const { callModel } = await import('../src/provider.js');
      await callModel(
        { provider: 'anthropic', model: 'claude-x', keyEnv: 'JRA_TEST_KEY', baseUrl: null, maxTokens: 64 },
        {
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', text: '' },
            { role: 'user', content: 'Continue, or call done() if the task is complete.' },
          ],
        },
      );
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.JRA_TEST_KEY;
    }

    const assistant = sent.messages[1];
    assert.equal(assistant.role, 'assistant');
    assert.ok(assistant.content.length > 0, 'an empty assistant turn is refused by the API');
    assert.equal(sent.messages[2].role, 'user', 'and the roles still alternate');
  });
});
