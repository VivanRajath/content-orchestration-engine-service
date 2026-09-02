import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from '../src/classify.js';
import { readManifest } from '../src/config.js';
import { extractJson } from '../src/provider.js';
import { TEMPLATES } from '../src/paths.js';

const DUTIES = readFileSync(join(TEMPLATES, 'DUTIES.md'), 'utf8');
const BASE = readManifest(join(TEMPLATES, 'agent.yaml'));

const manifest = (over = {}) => ({ ...BASE, ...over });

/** A stub model. Records what it was asked, replies with whatever text is given. */
function stub(text) {
  const calls = [];
  const fn = async (m, req) => {
    calls.push(req);
    return { text, toolCalls: [], stopReason: 'end_turn', raw: {} };
  };
  fn.calls = calls;
  return fn;
}

const reply = (tier, confidence, reason = 'because') => JSON.stringify({ tier, confidence, reason });

const run = (over, text, args = {}) =>
  classify({ task: 'add a button', manifest: manifest(over), duties: DUTIES, call: stub(text), ...args });

describe('readManifest reads the routing block', () => {
  test('the keys the run loop needs', () => {
    assert.equal(BASE.provider, 'anthropic');
    assert.equal(BASE.model, 'claude-sonnet-4-6');
    assert.equal(BASE.keyEnv, 'ANTHROPIC_API_KEY');
    assert.equal(BASE.baseUrl, null);
    assert.equal(BASE.entry, 'auto');
    assert.equal(BASE.temperature, 0.2);
    assert.equal(BASE.maxTokens, 8192);
    assert.equal(BASE.confidenceFloor, 0.6);
    assert.equal(BASE.diffCeiling, 400);
    assert.equal(BASE.juniorRetryLimit, 2);
    assert.equal(BASE.degradedFallback, 'senior-dev');
    assert.deepEqual(BASE.agents, ['build-doctor', 'senior-dev', 'junior-dev', 'ui-editor']);
  });
});

describe('routing.entry', () => {
  test('a pinned tier skips the model call entirely', async () => {
    const call = stub(reply('junior-dev', 0.9));
    const out = await classify({ task: 't', manifest: manifest({ entry: 'senior-dev' }), duties: DUTIES, call });
    assert.equal(out.tier, 'senior-dev');
    assert.equal(out.source, 'config');
    assert.equal(call.calls.length, 0, 'a pinned entry must not cost a call');
  });

  test('a pinned tier that is not a declared agent is a setup error', async () => {
    await assert.rejects(
      () => classify({ task: 't', manifest: manifest({ entry: 'nope' }), duties: DUTIES, call: stub('') }),
      /not in the agents list/,
    );
  });

  test('auto asks the model', async () => {
    const call = stub(reply('junior-dev', 0.9));
    const out = await classify({ task: 't', manifest: manifest(), duties: DUTIES, call });
    assert.equal(out.source, 'model');
    assert.equal(call.calls.length, 1);
  });
});

describe('repo state', () => {
  test('a red build routes to build-doctor without a call', async () => {
    // DUTIES.md entry rule 1 is deterministic; nothing else runs until green.
    const call = stub(reply('senior-dev', 0.9));
    const out = await classify({ task: 't', manifest: manifest(), duties: DUTIES, buildGreen: false, call });
    assert.equal(out.tier, 'build-doctor');
    assert.equal(out.source, 'repo-state');
    assert.equal(call.calls.length, 0);
  });

  test('unknown build state is not red', async () => {
    const out = await run({}, reply('junior-dev', 0.9), { buildGreen: null });
    assert.equal(out.tier, 'junior-dev');
  });

  test('a green build classifies normally', async () => {
    const out = await run({}, reply('ui-editor', 0.9), { buildGreen: true });
    assert.equal(out.tier, 'ui-editor');
  });
});

describe('confidence floor routes one tier up, never down', () => {
  test('junior-dev below the floor becomes senior-dev', async () => {
    const out = await run({}, reply('junior-dev', 0.4));
    assert.equal(out.tier, 'senior-dev');
    assert.equal(out.source, 'floor-bump');
    assert.equal(out.classified, 'junior-dev');
    assert.match(out.reason, /below floor 0\.6/);
  });

  test('ui-editor bumps sideways-up to junior-dev, not to senior-dev', async () => {
    // Peers split by domain: a shaky "this is presentational" is most likely
    // mixed logic work, which is junior's.
    const out = await run({}, reply('ui-editor', 0.3));
    assert.equal(out.tier, 'junior-dev');
  });

  test('senior-dev is terminal and does not bump past itself', async () => {
    const out = await run({}, reply('senior-dev', 0.1));
    assert.equal(out.tier, 'senior-dev');
    assert.equal(out.source, 'model');
  });

  test('build-doctor does not bump out of a red build', async () => {
    const out = await run({}, reply('build-doctor', 0.2));
    assert.equal(out.tier, 'build-doctor');
  });

  test('at or above the floor there is no bump', async () => {
    assert.equal((await run({}, reply('junior-dev', 0.6))).tier, 'junior-dev');
    assert.equal((await run({}, reply('junior-dev', 0.95))).tier, 'junior-dev');
  });

  test('the floor is read from the manifest', async () => {
    const out = await run({ confidenceFloor: 0.9 }, reply('junior-dev', 0.8));
    assert.equal(out.tier, 'senior-dev');
  });
});

describe('a model that cannot hold the shape does not pick the tier', () => {
  test('unparseable output falls back to routing.degraded_fallback', async () => {
    const out = await run({}, 'Sure! I think this is a junior task.');
    assert.equal(out.tier, 'senior-dev');
    assert.equal(out.source, 'fallback');
    assert.equal(out.confidence, 0);
  });

  test('an unknown tier name falls back', async () => {
    const out = await run({}, reply('mid-dev', 0.99));
    assert.equal(out.tier, 'senior-dev');
    assert.equal(out.source, 'fallback');
    assert.match(out.reason, /unknown tier "mid-dev"/);
  });

  test('the fallback is read from the manifest', async () => {
    const out = await run({ degradedFallback: 'junior-dev' }, 'garbage');
    assert.equal(out.tier, 'junior-dev');
  });

  test('a fenced reply still parses', async () => {
    const out = await run({}, '```json\n' + reply('ui-editor', 0.9) + '\n```');
    assert.equal(out.tier, 'ui-editor');
  });

  test('JSON with a preface still parses', async () => {
    const out = await run({}, 'Here you go: ' + reply('ui-editor', 0.9));
    assert.equal(out.tier, 'ui-editor');
  });

  test('a missing or absurd confidence is treated as no confidence', async () => {
    assert.equal((await run({}, JSON.stringify({ tier: 'junior-dev' }))).tier, 'senior-dev');
    assert.equal((await run({}, JSON.stringify({ tier: 'junior-dev', confidence: 7 }))).tier, 'junior-dev');
    assert.equal((await run({}, JSON.stringify({ tier: 'junior-dev', confidence: -3 }))).tier, 'senior-dev');
  });
});

describe('the prompt', () => {
  test('carries the user own DUTIES.md, not a baked-in copy', async () => {
    const call = stub(reply('junior-dev', 0.9));
    await classify({ task: 't', manifest: manifest(), duties: 'MY CUSTOM RULES', call });
    assert.match(call.calls[0].system, /MY CUSTOM RULES/);
  });

  test('carries the task, build state, and file list', async () => {
    const call = stub(reply('junior-dev', 0.9));
    await classify({
      task: 'make the header sticky',
      manifest: manifest(),
      duties: DUTIES,
      buildGreen: true,
      files: ['src/Header.tsx', 'src/app.css'],
      call,
    });
    const sent = call.calls[0].messages[0].content;
    assert.match(sent, /make the header sticky/);
    assert.match(sent, /Build state: green/);
    assert.match(sent, /src\/Header\.tsx/);
  });

  test('caps the file list rather than sending a whole monorepo', async () => {
    const call = stub(reply('junior-dev', 0.9));
    const files = Array.from({ length: 900 }, (_, i) => `src/file${i}.ts`);
    await classify({ task: 't', manifest: manifest(), duties: DUTIES, files, call });
    const sent = call.calls[0].messages[0].content;
    assert.match(sent, /and 600 more files/);
    assert.ok(!sent.includes('src/file400.ts'));
  });

  test('asks for one cheap deterministic call', async () => {
    const call = stub(reply('junior-dev', 0.9));
    await classify({ task: 't', manifest: manifest(), duties: DUTIES, call });
    assert.equal(call.calls[0].temperature, 0);
    assert.equal(call.calls[0].maxTokens, 256);
    assert.equal(call.calls[0].tools, undefined, 'classification needs no tools');
  });
});

describe('extractJson', () => {
  for (const [name, input, expected] of [
    ['plain', '{"a":1}', { a: 1 }],
    ['fenced', '```json\n{"a":1}\n```', { a: 1 }],
    ['prefaced', 'Sure. {"a":1}', { a: 1 }],
    ['trailing prose', '{"a":1} — hope that helps', { a: 1 }],
    ['not json', 'no json here', null],
    ['empty', '', null],
  ]) {
    test(name, () => assert.deepEqual(extractJson(input), expected));
  }
});
