import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens, estimateRequest, budgetFor, readCeiling, fit,
  calibrate, forgetRatios, charsPerToken, describeBudget, formatTokens, MIN_OUTPUT,
} from '../src/budget.js';

/**
 * The arithmetic that decides whether a request is sendable.
 *
 * Nothing here talks to a provider: the point of this module is to answer
 * "does this fit" without one, because asking costs an attempt.
 */

const GROQ = { provider: 'groq', model: 'llama-3.3-70b-versatile' };

beforeEach(() => forgetRatios());

describe('estimating', () => {
  test('counts characters over a ratio, and nothing is free', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.ok(estimateTokens('x'.repeat(360)) >= 100);
  });

  test('a request is its system prompt, its messages and its tool schemas', () => {
    const tools = [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } }];
    const system = 'y'.repeat(3600);
    const messages = [
      { role: 'user', content: 'z'.repeat(360) },
      { role: 'assistant', text: 'ok', toolCalls: [{ id: 'a', name: 'read_file', input: { path: 'x.js' } }] },
      { role: 'tool', results: [{ id: 'a', name: 'read_file', content: 'w'.repeat(3600) }] },
    ];

    const all = estimateRequest({ system, messages, tools });
    const withoutHistory = estimateRequest({ system, messages: [], tools });

    assert.ok(all > withoutHistory, 'history costs something');
    assert.ok(withoutHistory > 900, 'so does a 3,600-character prompt');
    // The tool result is the bulk of it, which is why trimming starts there.
    assert.ok(all - withoutHistory > 900);
  });

  test('a rejection teaches the real ratio, and an absurd one is ignored', () => {
    const before = charsPerToken(GROQ);
    calibrate(GROQ, { chars: 40000, tokens: 8000 });
    assert.equal(charsPerToken(GROQ), 5);
    assert.notEqual(charsPerToken(GROQ), before);

    calibrate(GROQ, { chars: 100, tokens: 0 });
    calibrate(GROQ, { chars: 10, tokens: 1000 });
    assert.equal(charsPerToken(GROQ), 5, 'a garbled count does not overwrite a good one');
  });
});

describe('the budget a key allows', () => {
  test('comes from the measured per-minute limit, with headroom', () => {
    assert.equal(budgetFor({ raw: { model: { tokens_per_minute: 8000 } } }), 7200);
    assert.equal(budgetFor({ tokensPerMinute: 8000 }), 7200);
  });

  test('is null when nothing has been measured, and then nothing is fitted', () => {
    assert.equal(budgetFor({}), null);
    assert.equal(budgetFor({ raw: { model: {} } }), null);
    assert.equal(budgetFor({ tokensPerMinute: 'plenty' }), null);

    const room = fit({ system: 'x'.repeat(100000), messages: [], budget: null, maxTokens: 4000 });
    assert.equal(room.fits, true, 'without a budget the provider is still the judge');
    assert.equal(room.maxTokens, 4000);
  });

  test('a read is a fraction of the budget, never a fixed 200k characters', () => {
    const small = readCeiling(7200, GROQ);
    assert.ok(small < 20000, `a small key cannot carry ${small} characters`);
    assert.ok(small > 2000, 'but it can carry something worth reading');
    assert.ok(readCeiling(200000, GROQ) > small, 'a bigger budget reads more');
    assert.ok(readCeiling(null, GROQ) <= 100000, 'and an unknown budget still has a ceiling');
  });
});

describe('fitting a request', () => {
  const tools = [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } }];

  test('the reply cap shrinks first, because a shorter answer still answers', () => {
    const room = fit({
      system: 'x'.repeat(7200),      // ~2k tokens
      messages: [{ role: 'user', content: 'do a thing' }],
      tools,
      maxTokens: 4000,
      budget: 4000,
    });

    assert.equal(room.fits, true);
    assert.ok(room.maxTokens < 4000, 'the cap gave way');
    assert.ok(room.maxTokens >= MIN_OUTPUT);
    assert.deepEqual(room.trimmed, [], 'and history was not touched to do it');
  });

  test('then the oldest tool output goes, leaving a note in its place', () => {
    const big = 'f'.repeat(30000);
    const messages = [
      { role: 'user', content: 'summarise the readme' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'a', name: 'read_file', input: {} }] },
      { role: 'tool', results: [{ id: 'a', name: 'read_file', content: big }] },
      { role: 'assistant', text: '', toolCalls: [{ id: 'b', name: 'list_files', input: {} }] },
      { role: 'tool', results: [{ id: 'b', name: 'list_files', content: 'src/index.js' }] },
    ];

    const room = fit({ system: 'x'.repeat(3600), messages, tools, maxTokens: 2000, budget: 6000 });

    assert.equal(room.fits, true);
    assert.equal(room.trimmed.length, 1);
    assert.equal(room.trimmed[0].name, 'read_file', 'the oldest and largest went');
    assert.notEqual(messages[2].results[0].content, big, 'it really was dropped, not just measured');
    assert.match(messages[2].results[0].content, /dropped to fit/);
    assert.match(messages[2].results[0].content, /Read it again/, 'the model is told it can re-read');
    assert.equal(messages[0].content, 'summarise the readme', 'the task is never trimmed');
    assert.equal(messages[4].results[0].content, 'src/index.js', 'nor the most recent turns');
  });

  test('a prompt bigger than the budget cannot be trimmed into one', () => {
    const room = fit({
      system: 'x'.repeat(36000),     // ~10k tokens of agent prompt
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      maxTokens: 1000,
      budget: 4000,
    });

    assert.equal(room.fits, false);
    assert.match(room.reason, /no room left to work in/);
    assert.match(room.reason, /prompt and tools/, 'and names what is too big');
  });

  test('what it reports is what a person can act on', () => {
    const line = describeBudget({ input: 2400, budget: 7200, maxTokens: 4000 });
    assert.match(line, /2\.4k per step/);
    assert.match(line, /8\.0k\/min/);
    assert.match(line, /step/);

    assert.equal(describeBudget({ input: 2400, budget: null }), '~2.4k tokens per step');
    assert.equal(formatTokens(950), '950');
    assert.equal(formatTokens(7200), '7.2k');
    assert.equal(formatTokens(48000), '48k');
  });
});

describe('what is left of the minute', () => {
  const headers = (h) => ({ get: (n) => h[n] ?? null });

  test('is read from any response, OpenAI-shaped or Anthropic', async () => {
    const { observe, liveRemaining, forgetLive } = await import('../src/budget.js');
    forgetLive();

    observe(GROQ, headers({
      'x-ratelimit-remaining-tokens': '1200',
      'x-ratelimit-limit-tokens': '8000',
      'x-ratelimit-reset-tokens': '42s',
    }), 1000);
    assert.equal(liveRemaining(GROQ, 1000), 1200);

    const CLAUDE = { provider: 'anthropic', model: 'claude-sonnet-4-6' };
    observe(CLAUDE, headers({
      'anthropic-ratelimit-input-tokens-remaining': '30000',
      'anthropic-ratelimit-input-tokens-limit': '40000',
      'anthropic-ratelimit-input-tokens-reset': new Date(61000).toISOString(),
    }), 1000);
    assert.equal(liveRemaining(CLAUDE, 1000), 30000);
    forgetLive();
  });

  test('stops describing the minute once the minute has turned over', async () => {
    const { observe, liveRemaining, msUntilRefill, forgetLive } = await import('../src/budget.js');
    forgetLive();
    observe(GROQ, headers({ 'x-ratelimit-remaining-tokens': '300', 'x-ratelimit-reset-tokens': '10s' }), 0);

    assert.equal(liveRemaining(GROQ, 5000), 300, 'still this minute');
    assert.equal(msUntilRefill(GROQ, 5000), 5000, 'the provider said how long');
    assert.equal(liveRemaining(GROQ, 10001), null, 'a refilled minute is not the old one');
    forgetLive();
  });

  test('a response with no rate-limit headers changes nothing', async () => {
    const { observe, liveRemaining, forgetLive } = await import('../src/budget.js');
    forgetLive();
    assert.equal(observe(GROQ, headers({})), null);
    assert.equal(liveRemaining(GROQ), null);
  });

  test('resets arrive as seconds, durations, or a timestamp', async () => {
    const { resetToMs } = await import('../src/budget.js');
    assert.equal(resetToMs('60'), 60000);
    assert.equal(resetToMs('7.5s'), 7500);
    assert.equal(resetToMs('1m2s'), 62000);
    assert.equal(resetToMs(new Date(3000).toISOString(), 1000), 2000);
    assert.equal(resetToMs(''), null);
  });
});

describe('DUTIES.md on a tight key', () => {
  const DUTIES = [
    '# Duties',
    '',
    'An explanation of this file, for the person reading it. '.repeat(20),
    '',
    '## Entry',
    '',
    'How the first agent is chosen. '.repeat(10),
    '',
    '## Escalation',
    '',
    'How an agent hands off. '.repeat(10),
    '',
    '## What travels with a handoff',
    '',
    'The record, not the transcript. '.repeat(40),
  ].join('\n');

  test('is sent exactly as written when there is room', async () => {
    const { fitDuties } = await import('../src/budget.js');
    assert.equal(fitDuties(DUTIES, null), DUTIES, 'no budget, no change');
    assert.equal(fitDuties(DUTIES, 200000), DUTIES, 'a big key gets the whole file');
  });

  test('loses its preamble and later sections first, and says so', async () => {
    const { fitDuties, estimateTokens } = await import('../src/budget.js');
    const short = fitDuties(DUTIES, 7200);

    assert.ok(estimateTokens(short) < estimateTokens(DUTIES), 'it got smaller');
    assert.doesNotMatch(short, /An explanation of this file/, 'the preamble is the first to go');
    assert.match(short, /^## Entry/, 'the protocol starts where the file does');
    assert.match(short, /Shortened to fit/, 'and the model is told it is not the whole file');
    assert.match(short, /still enforced by the harness/);
  });
});

describe('a reply that has to be sent again with more room', () => {
  test('fit can require a bigger reply than the floor', () => {
    const room = fit({
      system: 'x'.repeat(3600),
      messages: [{ role: 'user', content: 'write the file' }],
      maxTokens: 4000,
      budget: 6000,
      minOutput: 3000,
    });
    assert.equal(room.fits, true);
    assert.ok(room.maxTokens >= 3000, 'the retry gets at least the room it asked for');

    const tight = fit({
      system: 'x'.repeat(3600),
      messages: [{ role: 'user', content: 'write the file' }],
      maxTokens: 4000,
      budget: 2500,
      minOutput: 3000,
    });
    assert.equal(tight.fits, false, 'and when that room is not there, it says so rather than sending less');
  });
});
