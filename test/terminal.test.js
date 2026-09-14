import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompter } from '../src/prompter.js';
import { callModel } from '../src/provider.js';

/**
 * The prompter in TERMINAL mode.
 *
 * Every earlier test ran readline over plain streams, which puts it in
 * non-terminal mode — a different code path from a real terminal's. Every bug
 * a user hit at the keyboard lived in the part those tests never reached: the
 * API key prompt with no label and no echo, Ctrl+V pasting nothing on Windows,
 * and a second readline interface that left the chat deaf to input.
 *
 * These streams claim to be a TTY, so readline takes its terminal path: raw
 * mode, keypress parsing, line redraws. Keys are sent one at a time, and Enter
 * is `\r`, the way a real terminal sends it.
 */

function fakeTTY() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  let screen = '';
  output.on('data', (d) => { screen += d.toString(); });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    input,
    output,
    wait,
    async type(text, { enter = true } = {}) {
      for (const ch of text) { input.write(ch); await wait(2); }
      if (enter) input.write('\r');
      await wait(25);
    },
    async paste(text) {
      input.write(text);
      await wait(10);
      input.write('\r');
      await wait(25);
    },
    visible: () => screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''),
    clear: () => { screen = ''; },
  };
}

const within = (p, ms = 2000) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for input')), ms))]);

describe('secret input in a terminal', () => {
  test('the label stays on screen', async () => {
    const t = fakeTTY();
    const p = createPrompter({ input: t.input, output: t.output });
    const answer = p.secret('API key:');
    await t.wait(20);
    await t.paste('gsk_value');
    await within(answer);
    // Before: the label was written separately and readline's redraw wiped it,
    // leaving a blank line that looked like it was ignoring the keyboard.
    assert.match(t.visible(), /API key:/);
    p.close();
  });

  test('a pasted key is received whole', async () => {
    const t = fakeTTY();
    const p = createPrompter({ input: t.input, output: t.output });
    const answer = p.secret('API key:');
    await t.wait(20);
    await t.paste('gsk_pasted_in_one_burst_1234');
    assert.equal(await within(answer), 'gsk_pasted_in_one_burst_1234');
    p.close();
  });

  // Visible proof the paste landed — before, echo was off entirely, so nothing
  // appeared and a paste looked like it had failed.
  test('it echoes a star per character, and never the key', async () => {
    const t = fakeTTY();
    const p = createPrompter({ input: t.input, output: t.output });
    const answer = p.secret('API key:');
    await t.wait(20);
    await t.paste('gsk_secret_value_abc');
    await within(answer);
    const screen = t.visible();
    assert.match(screen, /\*{10,}/, 'no stars were echoed');
    assert.ok(!screen.includes('gsk_secret'), 'the key was echoed to the screen');
    p.close();
  });

  test('typing and backspace work', async () => {
    const t = fakeTTY();
    const p = createPrompter({ input: t.input, output: t.output });
    const answer = p.secret('API key:');
    await t.wait(20);
    await t.type('gsk_abcX', { enter: false });
    t.input.write('\x7f');
    await t.wait(15);
    t.input.write('\r');
    assert.equal(await within(answer), 'gsk_abc');
    p.close();
  });

  test('ordinary questions afterwards echo normally', async () => {
    const t = fakeTTY();
    const p = createPrompter({ input: t.input, output: t.output });
    const secret = p.secret('API key:');
    await t.wait(20);
    await t.paste('gsk_x');
    await within(secret);

    t.clear();
    const next = p.ask('Task:');
    await t.wait(20);
    await t.type('add a button');
    assert.equal(await within(next), 'add a button');
    assert.match(t.visible(), /add a button/, 'masking leaked into a normal question');
    p.close();
  });
});

describe('Ctrl+V on Windows', () => {
  // A raw-mode Windows console hands Ctrl+V to the program as a literal ^V
  // keypress rather than pasting. readline ignores it, so pasting a key with
  // Ctrl+V silently did nothing.
  test('^V inserts the clipboard', async () => {
    const t = fakeTTY();
    const p = createPrompter({
      input: t.input, output: t.output, platform: 'win32',
      readClipboard: () => 'gsk_from_the_clipboard',
    });
    const answer = p.secret('API key:');
    await t.wait(20);
    t.input.write('\x16');
    await t.wait(30);
    t.input.write('\r');
    assert.equal(await within(answer), 'gsk_from_the_clipboard');
    assert.ok(!t.visible().includes('gsk_from_the_clipboard'));
    p.close();
  });

  // A trailing newline in the clipboard would otherwise submit the answer
  // before the user had seen it.
  test('a clipboard newline does not submit early', async () => {
    const t = fakeTTY();
    const p = createPrompter({
      input: t.input, output: t.output, platform: 'win32',
      readClipboard: () => 'gsk_line\r\n',
    });
    const answer = p.ask('Key:');
    await t.wait(20);
    t.input.write('\x16');
    await t.wait(30);
    await t.type('_more');
    assert.equal(await within(answer), 'gsk_line_more');
    p.close();
  });

  test('elsewhere, ^V is left to the terminal', async () => {
    let read = false;
    const t = fakeTTY();
    const p = createPrompter({
      input: t.input, output: t.output, platform: 'linux',
      readClipboard: () => { read = true; return 'x'; },
    });
    const answer = p.ask('Key:');
    await t.wait(20);
    t.input.write('\x16');
    await t.wait(20);
    await t.type('typed');
    await within(answer);
    assert.equal(read, false);
    p.close();
  });
});

describe('a long conversation', () => {
  test('forty questions in a row all get their answers, with no leak warning', async () => {
    const warnings = [];
    const onWarning = (w) => warnings.push(w.name);
    process.on('warning', onWarning);
    const t = fakeTTY();
    const p = createPrompter({ input: t.input, output: t.output });
    try {
      for (let i = 0; i < 40; i++) {
        const answer = p.ask(`q${i}`);
        await t.wait(5);
        await t.type(`answer ${i}`);
        assert.equal(await within(answer), `answer ${i}`);
      }
      await t.wait(20);
      assert.ok(!warnings.includes('MaxListenersExceededWarning'), 'listener leak');
    } finally {
      process.off('warning', onWarning);
      p.close();
    }
  });

  test('closing the prompter resolves a pending question instead of hanging', async () => {
    const t = fakeTTY();
    const p = createPrompter({ input: t.input, output: t.output });
    const answer = p.ask('never answered');
    await t.wait(20);
    p.close();
    assert.equal(await within(answer), null);
  });
});

describe('a stream request answered with plain JSON', () => {
  // Some OpenAI-compatible servers ignore `stream: true`. The body went to the
  // SSE parser, found no `data:` lines, and read as an empty reply — so every
  // task failed with "the model called no tool" when the model had called one.
  test('its tool call is still read', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: {
        content: 'on it',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'done', arguments: '{"summary":"ok"}' } }],
      } }] }),
    });
    process.env.JRA_TEST_STREAM_KEY = 'k';
    const seen = [];
    try {
      const r = await callModel(
        { provider: 'openai-compatible', model: 'm', keyEnv: 'JRA_TEST_STREAM_KEY', baseUrl: 'http://127.0.0.1:9/v1' },
        { messages: [{ role: 'user', content: 'x' }], onDelta: (d) => seen.push(d) },
      );
      assert.equal(r.toolCalls.length, 1);
      assert.equal(r.toolCalls[0].name, 'done');
      assert.deepEqual(seen, ['on it'], 'the text should still reach the screen once');
    } finally {
      globalThis.fetch = original;
      delete process.env.JRA_TEST_STREAM_KEY;
    }
  });
});
