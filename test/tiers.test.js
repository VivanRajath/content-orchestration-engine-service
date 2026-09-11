import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest, modelFor, keyEnvs } from '../src/config.js';

/**
 * Per-tier models. The premise of a tier ladder is that tiers differ in cost
 * and judgement, so pointing them at different models is the point, not a
 * flourish: a cheap model for scoped junior work, an expensive one for
 * architecture.
 */
const BASE = `apiVersion: gitagent/v1
kind: Agent
metadata:
  name: t
model:
  provider: anthropic
  name: claude-sonnet-4-6
  api_key_env: ANTHROPIC_API_KEY
  base_url: null
  temperature: 0.2
  max_tokens: 8192
agents:
  - junior-dev
  - senior-dev
routing:
  entry: auto
`;

function withManifest(extra = '') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jra-tiers-')));
  const file = join(dir, 'agent.yaml');
  writeFileSync(file, BASE + extra);
  const m = readManifest(file);
  rmSync(dir, { recursive: true, force: true });
  return m;
}

describe('modelFor', () => {
  test('a tier with no override inherits everything', () => {
    const m = withManifest();
    const t = modelFor(m, 'junior-dev');
    assert.equal(t.model, 'claude-sonnet-4-6');
    assert.equal(t.provider, 'anthropic');
    assert.equal(t.keyEnv, 'ANTHROPIC_API_KEY');
  });

  test('a tier can name its own model and key', () => {
    const m = withManifest(`tiers:
  junior-dev:
    model:
      provider: openai
      name: gpt-4o-mini
      api_key_env: OPENAI_API_KEY
`);
    const junior = modelFor(m, 'junior-dev');
    assert.equal(junior.provider, 'openai');
    assert.equal(junior.model, 'gpt-4o-mini');
    assert.equal(junior.keyEnv, 'OPENAI_API_KEY');

    // Untouched tiers must not move.
    const senior = modelFor(m, 'senior-dev');
    assert.equal(senior.provider, 'anthropic');
    assert.equal(senior.model, 'claude-sonnet-4-6');
  });

  test('an override inherits temperature and max_tokens it does not set', () => {
    const m = withManifest(`tiers:
  junior-dev:
    model:
      name: gpt-4o-mini
`);
    const t = modelFor(m, 'junior-dev');
    assert.equal(t.temperature, 0.2);
    assert.equal(t.maxTokens, 8192);
  });

  // Inheriting a base_url across a provider change points an Anthropic tier at
  // an OpenAI-compatible endpoint, which fails in a way nobody can read.
  test('changing provider drops an inherited base_url', () => {
    const m = withManifest(`tiers:
  junior-dev:
    model:
      provider: openai
      name: gpt-4o-mini
`);
    const base = { ...m, baseUrl: 'https://my-proxy.test/v1' };
    assert.equal(modelFor(base, 'junior-dev').baseUrl, null);
  });

  test('the same provider keeps the inherited base_url', () => {
    const m = withManifest(`tiers:
  junior-dev:
    model:
      name: claude-haiku-4-5
`);
    const base = { ...m, baseUrl: 'https://my-proxy.test/v1' };
    assert.equal(modelFor(base, 'junior-dev').baseUrl, 'https://my-proxy.test/v1');
  });

  test('an explicit base_url wins', () => {
    const m = withManifest(`tiers:
  junior-dev:
    model:
      provider: openai-compatible
      name: llama
      base_url: https://api.together.xyz/v1
`);
    assert.equal(modelFor(m, 'junior-dev').baseUrl, 'https://api.together.xyz/v1');
  });

  test('the result carries the tier, so a caller can say which model ran', () => {
    const m = withManifest(`tiers:
  junior-dev:
    model:
      name: gpt-4o-mini
`);
    assert.equal(modelFor(m, 'junior-dev').tier, 'junior-dev');
  });

  test('a manifest with no tiers block behaves exactly as before', () => {
    const m = withManifest();
    assert.deepEqual(m.tiers, {});
    assert.equal(modelFor(m, 'anything'), m);
  });
});

describe('keyEnvs', () => {
  test('collects every variable the manifest references', () => {
    const m = withManifest(`tiers:
  junior-dev:
    model:
      api_key_env: OPENAI_API_KEY
  senior-dev:
    model:
      api_key_env: ANTHROPIC_API_KEY
`);
    assert.deepEqual(keyEnvs(m).sort(), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  });

  test('deduplicates a shared key', () => {
    const m = withManifest(`tiers:
  junior-dev:
    model:
      api_key_env: ANTHROPIC_API_KEY
`);
    assert.deepEqual(keyEnvs(m), ['ANTHROPIC_API_KEY']);
  });
});
