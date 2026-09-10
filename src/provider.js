/**
 * The two provider shapes, normalized. Lifted out of doctor.js so the probe,
 * the classifier, and the run loop all speak to the model through one place
 * rather than three copies of fetch.
 *
 * Transcripts are held in a provider-neutral form and converted at call time:
 *
 *   {role:'user',      content: string}
 *   {role:'assistant', text: string, toolCalls: [{id, name, input}]}
 *   {role:'tool',      results: [{id, name, content, isError}]}
 *
 * The key is read from the env var named in agent.yaml and is never written,
 * logged, or included in an error. redact() enforces that on the way out
 * rather than trusting every call site to remember.
 */

const DEFAULT_ANTHROPIC = 'https://api.anthropic.com';
const DEFAULT_OPENAI = 'https://api.openai.com/v1';

export function apiKey(manifest) {
  return process.env[manifest.keyEnv] || '';
}

/**
 * One message for a missing key, in one place.
 *
 * Three copies of "here is how to set your key" is three chances to leave one
 * of them saying `export`, which is not a command on the platform a good share
 * of users are typing into.
 */
export function missingKey(name) {
  return [
    `$${name} is not set.`,
    '  Store one:  jr-arch key <your-key>',
    '  Or set that variable in your shell.',
  ].join('\n');
}

/** Never let a key value reach a log, a transcript, or an error message. */
export function redact(text, key) {
  const s = String(text);
  return key && key.length > 8 ? s.split(key).join('[redacted]') : s;
}

export function isAnthropic(manifest) {
  return manifest.provider === 'anthropic';
}

/** ollama and other openai-compatible endpoints often need no key at all. */
export function requiresKey(manifest) {
  return manifest.provider !== 'ollama';
}

// ---------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------

function toAnthropicMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'assistant') {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const call of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} });
      }
      return { role: 'assistant', content };
    }
    // Tool results come back as a user turn in the Anthropic shape.
    return {
      role: 'user',
      content: (m.results ?? []).map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: String(r.content ?? ''),
        is_error: Boolean(r.isError),
      })),
    };
  });
}

function toOpenAIMessages(messages, system) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...((m.toolCalls ?? []).length
          ? {
              tool_calls: m.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
              })),
            }
          : {}),
      });
    } else {
      for (const r of m.results ?? []) {
        out.push({ role: 'tool', tool_call_id: r.id, content: String(r.content ?? '') });
      }
    }
  }
  return out;
}

const toOpenAITools = (tools) =>
  tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

async function post(url, headers, body, key, { retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (err) {
      lastError = new Error(redact(err.message, key));
      if (attempt === retries) throw lastError;
      await sleep(backoff(attempt));
      continue;
    }
    if (res.ok) return res.json();

    const text = redact((await res.text()).slice(0, 400), key);
    lastError = new Error(`${res.status} ${text}`);
    if (!RETRY_STATUS.has(res.status) || attempt === retries) throw lastError;
    // A long Retry-After is the provider telling us to stop, not to wait it out.
    const after = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 15000) : backoff(attempt);
    await sleep(wait);
  }
  throw lastError;
}

const backoff = (attempt) => Math.min(1000 * 2 ** attempt, 8000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Streaming exists for one reason: without it a long attempt prints nothing
 * until the model finishes, which reads as a hang rather than as work.
 *
 * Retries stop at the first byte. `post` can safely replay a request that
 * never produced a response, but once tokens have been handed to the caller
 * and printed to a terminal, replaying would duplicate them — so a mid-stream
 * failure is an error, not a retry.
 */
async function postStream(url, headers, body, key, { retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, accept: 'text/event-stream' },
        body: JSON.stringify({ ...body, stream: true }),
      });
    } catch (err) {
      lastError = new Error(redact(err.message, key));
      if (attempt === retries) throw lastError;
      await sleep(backoff(attempt));
      continue;
    }
    if (res.ok) {
      if (!res.body) throw new Error('the provider returned no response body to stream');
      return res.body;
    }

    const text = redact((await res.text()).slice(0, 400), key);
    lastError = new Error(`${res.status} ${text}`);
    if (!RETRY_STATUS.has(res.status) || attempt === retries) throw lastError;
    const after = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 15000) : backoff(attempt));
  }
  throw lastError;
}

/**
 * Server-sent events out of a byte stream.
 *
 * Buffers across chunk boundaries: a network chunk splits wherever TCP decided
 * to, routinely mid-JSON and mid-line, and parsing each chunk on its own drops
 * exactly the events that happen to straddle one.
 */
export async function* parseSSE(source) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;      // event:, id:, comments, blanks
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;     // OpenAI's terminator is not JSON
      try {
        yield JSON.parse(data);
      } catch {
        // A malformed frame is one lost token, not a lost run.
      }
    }
  }
}

/**
 * Anthropic's streaming shape. Content arrives as indexed blocks: text blocks
 * deliver text_delta, tool_use blocks deliver their arguments as a JSON string
 * split across input_json_delta frames, which has to be accumulated and parsed
 * once the block closes rather than per frame.
 */
export async function readAnthropicStream(events, onDelta) {
  const blocks = [];
  let stopReason = null;

  for await (const e of events) {
    if (e.type === 'content_block_start') {
      blocks[e.index] = { ...e.content_block, text: '', json: '' };
    } else if (e.type === 'content_block_delta') {
      const b = blocks[e.index] ?? (blocks[e.index] = { type: 'text', text: '', json: '' });
      if (e.delta?.type === 'text_delta') {
        b.text += e.delta.text ?? '';
        onDelta?.(e.delta.text ?? '');
      } else if (e.delta?.type === 'input_json_delta') {
        b.json += e.delta.partial_json ?? '';
      }
    } else if (e.type === 'message_delta') {
      stopReason = e.delta?.stop_reason ?? stopReason;
    } else if (e.type === 'error') {
      throw new Error(e.error?.message ?? 'the provider reported a stream error');
    }
  }

  return {
    text: blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(''),
    toolCalls: blocks
      .filter((b) => b?.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.json ? safeParse(b.json) : b.input ?? {} })),
    stopReason,
    raw: null,
  };
}

/**
 * OpenAI's streaming shape. Tool calls arrive as deltas keyed by index, with
 * the id and name usually only on the first frame and `arguments` accumulating
 * as a string across the rest.
 */
export async function readOpenAIStream(events, onDelta) {
  let text = '';
  let stopReason = null;
  const calls = [];

  for await (const e of events) {
    const choice = e.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if (delta.content) {
      text += delta.content;
      onDelta?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const slot = calls[i] ?? (calls[i] = { id: null, name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    if (choice.finish_reason) stopReason = choice.finish_reason;
  }

  return {
    text,
    toolCalls: calls.filter(Boolean).map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.name,
      input: safeParse(c.args || '{}'),
    })),
    stopReason,
    raw: null,
  };
}

/**
 * One model call. Returns {text, toolCalls, stopReason, raw} whichever
 * provider answered.
 *
 * Passing `onDelta` streams: the same result comes back at the end, but text
 * arrives at the callback as it is generated. Callers that do not care about
 * progress pass nothing and get the buffered path, which is one request and
 * one JSON parse rather than a stream to drain.
 */
export async function callModel(manifest, { system, messages = [], tools, maxTokens, temperature, onDelta } = {}) {
  const key = apiKey(manifest);
  if (!key && requiresKey(manifest)) {
    throw new Error(missingKey(manifest.keyEnv));
  }
  const limit = maxTokens ?? manifest.maxTokens ?? 4096;
  const temp = temperature ?? manifest.temperature ?? 0.2;

  if (isAnthropic(manifest)) {
    const url = `${(manifest.baseUrl || DEFAULT_ANTHROPIC).replace(/\/$/, '')}/v1/messages`;
    const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const payload = {
      model: manifest.model,
      max_tokens: limit,
      temperature: temp,
      ...(system ? { system } : {}),
      ...(tools?.length ? { tools } : {}),
      messages: toAnthropicMessages(messages),
    };

    if (onDelta) {
      const body = await postStream(url, headers, payload, key);
      return readAnthropicStream(parseSSE(body), (t) => onDelta(redact(t, key)));
    }

    const data = await post(url, headers, payload, key);
    const blocks = data.content ?? [];
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} })),
      stopReason: data.stop_reason ?? null,
      raw: data,
    };
  }

  const url = `${(manifest.baseUrl || DEFAULT_OPENAI).replace(/\/$/, '')}/chat/completions`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  const payload = {
    model: manifest.model,
    max_tokens: limit,
    temperature: temp,
    ...(tools?.length ? { tools: toOpenAITools(tools) } : {}),
    messages: toOpenAIMessages(messages, system),
  };

  if (onDelta) {
    const body = await postStream(url, headers, payload, key);
    return readOpenAIStream(parseSSE(body), (t) => onDelta(redact(t, key)));
  }

  const data = await post(url, headers, payload, key);
  const message = data.choices?.[0]?.message ?? {};
  return {
    text: message.content ?? '',
    toolCalls: (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function?.name,
      input: safeParse(call.function?.arguments),
    })),
    stopReason: data.choices?.[0]?.finish_reason ?? null,
    raw: data,
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text ?? '{}');
  } catch {
    // A model that emits malformed tool arguments should get a tool error back,
    // not crash the run. The loop reports the parse failure to it.
    return { __parseError: String(text ?? '').slice(0, 500) };
  }
}

/** Pull a JSON object out of a reply that may be fenced or prefaced with prose. */
export function extractJson(text) {
  const cleaned = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
