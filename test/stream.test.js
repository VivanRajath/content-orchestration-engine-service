import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE, readAnthropicStream, readOpenAIStream } from '../src/provider.js';

/**
 * The stream readers, fed synthetic frames.
 *
 * The interesting cases are all about chunk boundaries. A network chunk splits
 * wherever TCP decided to — routinely mid-JSON, mid-line, and between the \r
 * and the \n — so every test here also runs its input split one byte at a time
 * to prove the buffering holds.
 */

async function* chunks(...parts) {
  for (const p of parts) yield p;
}

/** The same payload delivered one character per chunk. */
async function* byByte(text) {
  for (const ch of text) yield ch;
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

describe('parseSSE', () => {
  test('reads whole frames', async () => {
    const out = [];
    for await (const e of parseSSE(chunks(sse({ a: 1 }), sse({ a: 2 })))) out.push(e);
    assert.deepEqual(out, [{ a: 1 }, { a: 2 }]);
  });

  test('reassembles a frame split across chunks', async () => {
    const out = [];
    for await (const e of parseSSE(chunks('data: {"a"', ':1}\n\ndata: {"b":2}\n\n'))) out.push(e);
    assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
  });

  test('survives being split one byte at a time', async () => {
    const payload = sse({ hello: 'world' }) + sse({ n: 42 });
    const out = [];
    for await (const e of parseSSE(byByte(payload))) out.push(e);
    assert.deepEqual(out, [{ hello: 'world' }, { n: 42 }]);
  });

  test('ignores comments, event lines, and blank lines', async () => {
    const raw = `: ping\nevent: message\n${sse({ a: 1 })}\n\nid: 7\n`;
    const out = [];
    for await (const e of parseSSE(chunks(raw))) out.push(e);
    assert.deepEqual(out, [{ a: 1 }]);
  });

  test("OpenAI's [DONE] terminator is not treated as JSON", async () => {
    const out = [];
    for await (const e of parseSSE(chunks(sse({ a: 1 }), 'data: [DONE]\n\n'))) out.push(e);
    assert.deepEqual(out, [{ a: 1 }]);
  });

  // One dropped frame is one lost token; throwing would lose the whole run.
  test('a malformed frame is skipped, not fatal', async () => {
    const out = [];
    for await (const e of parseSSE(chunks('data: {broken\n\n', sse({ a: 1 })))) out.push(e);
    assert.deepEqual(out, [{ a: 1 }]);
  });

  test('handles CRLF line endings', async () => {
    const out = [];
    for await (const e of parseSSE(chunks('data: {"a":1}\r\n\r\n'))) out.push(e);
    assert.deepEqual(out, [{ a: 1 }]);
  });

  test('decodes bytes, not just strings', async () => {
    const bytes = new TextEncoder().encode(sse({ a: 1 }));
    const out = [];
    for await (const e of parseSSE(chunks(bytes))) out.push(e);
    assert.deepEqual(out, [{ a: 1 }]);
  });
});

describe('readAnthropicStream', () => {
  const conversation = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the file.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path"' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"src/a.js"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];

  test('assembles text and tool calls', async () => {
    const seen = [];
    const r = await readAnthropicStream(parseSSE(chunks(conversation.map(sse).join(''))), (t) => seen.push(t));
    assert.equal(r.text, 'Reading the file.');
    assert.equal(r.stopReason, 'tool_use');
    assert.deepEqual(r.toolCalls, [{ id: 'tu_1', name: 'read_file', input: { path: 'src/a.js' } }]);
    assert.deepEqual(seen, ['Reading ', 'the file.']);
  });

  // Tool arguments arrive as a JSON string split across frames, so parsing has
  // to happen once at the end — per frame it is never valid JSON.
  test('tool arguments split byte-by-byte still parse', async () => {
    const r = await readAnthropicStream(parseSSE(byByte(conversation.map(sse).join(''))));
    assert.deepEqual(r.toolCalls[0].input, { path: 'src/a.js' });
  });

  test('onDelta fires only for text, never for tool arguments', async () => {
    const seen = [];
    await readAnthropicStream(parseSSE(chunks(conversation.map(sse).join(''))), (t) => seen.push(t));
    assert.ok(!seen.join('').includes('src/a.js'), 'tool json leaked into the visible stream');
  });

  test('an error frame throws', async () => {
    const raw = sse({ type: 'error', error: { message: 'overloaded' } });
    await assert.rejects(() => readAnthropicStream(parseSSE(chunks(raw))), /overloaded/);
  });

  test('malformed tool json comes back as a parse error, not a throw', async () => {
    const raw = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'x' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{not json' } },
      { type: 'content_block_stop', index: 0 },
    ].map(sse).join('');
    const r = await readAnthropicStream(parseSSE(chunks(raw)));
    assert.ok('__parseError' in r.toolCalls[0].input);
  });
});

describe('readOpenAIStream', () => {
  const conversation = [
    { choices: [{ delta: { content: 'Reading ' } }] },
    { choices: [{ delta: { content: 'the file.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"src/a.js"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];

  test('assembles text and tool calls', async () => {
    const seen = [];
    const r = await readOpenAIStream(parseSSE(chunks(conversation.map(sse).join(''))), (t) => seen.push(t));
    assert.equal(r.text, 'Reading the file.');
    assert.equal(r.stopReason, 'tool_calls');
    assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'read_file', input: { path: 'src/a.js' } }]);
    assert.deepEqual(seen, ['Reading ', 'the file.']);
  });

  // The id and name arrive on the first frame only; the rest carry arguments.
  test('accumulates arguments across frames that omit id and name', async () => {
    const r = await readOpenAIStream(parseSSE(byByte(conversation.map(sse).join(''))));
    assert.equal(r.toolCalls[0].name, 'read_file');
    assert.deepEqual(r.toolCalls[0].input, { path: 'src/a.js' });
  });

  test('keeps parallel tool calls apart by index', async () => {
    const raw = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":"x"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'list_files', arguments: '{"path":"y"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ].map(sse).join('');
    const r = await readOpenAIStream(parseSSE(chunks(raw)));
    assert.equal(r.toolCalls.length, 2);
    assert.deepEqual(r.toolCalls.map((t) => t.name), ['read_file', 'list_files']);
    assert.deepEqual(r.toolCalls[1].input, { path: 'y' });
  });

  test('a text-only reply has no tool calls', async () => {
    const raw = [
      { choices: [{ delta: { content: 'just talking' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ].map(sse).join('');
    const r = await readOpenAIStream(parseSSE(chunks(raw)));
    assert.equal(r.text, 'just talking');
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.stopReason, 'stop');
  });
});

describe('both readers agree on the shape callModel promises', () => {
  test('every field the loop reads is present', async () => {
    const a = await readAnthropicStream(parseSSE(chunks(sse({ type: 'message_stop' }))));
    const o = await readOpenAIStream(parseSSE(chunks(sse({ choices: [{ delta: {} }] }))));
    for (const r of [a, o]) {
      assert.equal(typeof r.text, 'string');
      assert.ok(Array.isArray(r.toolCalls));
      assert.ok('stopReason' in r);
    }
  });
});
