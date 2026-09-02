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

/**
 * One model call. Returns {text, toolCalls, stopReason, raw} whichever
 * provider answered.
 */
export async function callModel(manifest, { system, messages = [], tools, maxTokens, temperature } = {}) {
  const key = apiKey(manifest);
  if (!key && requiresKey(manifest)) {
    throw new Error(`$${manifest.keyEnv} is not set.`);
  }
  const limit = maxTokens ?? manifest.maxTokens ?? 4096;
  const temp = temperature ?? manifest.temperature ?? 0.2;

  if (isAnthropic(manifest)) {
    const data = await post(
      `${(manifest.baseUrl || DEFAULT_ANTHROPIC).replace(/\/$/, '')}/v1/messages`,
      { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      {
        model: manifest.model,
        max_tokens: limit,
        temperature: temp,
        ...(system ? { system } : {}),
        ...(tools?.length ? { tools } : {}),
        messages: toAnthropicMessages(messages),
      },
      key,
    );
    const blocks = data.content ?? [];
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} })),
      stopReason: data.stop_reason ?? null,
      raw: data,
    };
  }

  const data = await post(
    `${(manifest.baseUrl || DEFAULT_OPENAI).replace(/\/$/, '')}/chat/completions`,
    { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    {
      model: manifest.model,
      max_tokens: limit,
      temperature: temp,
      ...(tools?.length ? { tools: toOpenAITools(tools) } : {}),
      messages: toOpenAIMessages(messages, system),
    },
    key,
  );
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
