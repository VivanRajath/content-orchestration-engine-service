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

import { baseUrlFor, wireFor, providerFor } from './providers.js';
import { calibrate, observe } from './budget.js';

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
  return wireFor(manifest.provider) === 'anthropic';
}

/**
 * Does this configuration need an API key at all?
 *
 * Ollama says so in the registry. The other keyless case is a local server —
 * vLLM, LM Studio, llama.cpp behind `openai-compatible` — which authenticates
 * nothing. Treating those as needing a key sent the user back through
 * onboarding on every launch, because the chat's setup check saw a variable
 * that was unset and could never usefully be set.
 */
export function requiresKey(manifest) {
  if (providerFor(manifest.provider)?.noKey) return false;
  return !isLocal(manifest.baseUrl);
}

const LOCAL_HOST = /^(?:localhost|127(?:\.\d+){1,3}|\[::1\]|0\.0\.0\.0|host\.docker\.internal)$/i;

/** A base URL that points at this machine, so there is nobody to authenticate to. */
export function isLocal(baseUrl) {
  if (!baseUrl) return false;
  try {
    return LOCAL_HOST.test(new URL(String(baseUrl)).hostname);
  } catch {
    return false;
  }
}

/**
 * The endpoint for a manifest, never a guess.
 *
 * This used to be `baseUrl || 'https://api.openai.com/v1'` for everything that
 * was not Anthropic, so a Groq or OpenRouter key with no base_url configured
 * was sent to OpenAI. Resolving through the provider table means a key only
 * ever goes to the provider it belongs to.
 */
function endpoint(manifest) {
  const base = baseUrlFor(manifest.provider, manifest.baseUrl);
  if (!base) {
    throw new Error([
      `No base_url for provider "${manifest.provider}". Set one:`,
      '  jr-arch config set model.base_url <url>',
    ].join('\n'));
  }
  return base;
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
      // An assistant turn with nothing in it is rejected outright by the
      // Messages API, which fails the whole run. It happens for real: a reply
      // cut off at max_tokens before it produced any text arrives as empty, and
      // the loop's next move is to nudge the model — so the turn it is nudging
      // about has to be representable. Dropping the turn instead would leave
      // two user turns in a row, which the same API also refuses.
      if (!content.length) content.push({ type: 'text', text: '(no reply)' });
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

/** Longest the CLI will sit out a rate limit before giving up and saying so. */
export const MAX_WAIT_MS = 90000;
/** Below this, a shrunken reply budget is too small to do any real work in. */
const MIN_OUTPUT = 400;

/**
 * An error from the provider, already turned into something a person can act on.
 *
 * The raw body used to be printed as-is — four hundred characters of JSON with
 * an organisation id and an upgrade link in it, cut off mid-sentence. `kind` is
 * what the retry logic branches on:
 *
 *   too-large   this one request exceeds a per-minute token limit. Waiting will
 *               not help; asking for fewer output tokens might.
 *   rate-limit  the minute's (or day's) budget is spent. Waiting helps.
 *   auth        the key was refused.
 *   model       the model does not exist, or cannot do what was asked.
 *   server      the provider is having trouble.
 */
/**
 * Will this error be exactly the same on the next attempt?
 *
 * A wrong key and a model that cannot do what was asked are settings, not
 * weather. The ladder used to treat them as ordinary attempt failures: a model
 * without tool calling burned two attempts at one agent, escalated, burned two
 * more at the next, and reported the same sentence four times — four paid
 * requests to learn something the first reply already said.
 */
export function isFatalProviderError(err) {
  return err instanceof ProviderError && (err.kind === 'model' || err.kind === 'auth');
}

export class ProviderError extends Error {
  constructor(message, fields = {}) {
    super(message);
    Object.assign(this, fields);
  }
}

/**
 * Output-token ceilings learned from the provider during this process, keyed by
 * provider and model. Groq's free tier caps some models at 1,000 output tokens a
 * minute and rejects any request that merely ASKS for more — so the first
 * rejection teaches the cap, and every later call starts under it instead of
 * failing the same way first.
 */
const learnedCaps = new Map();
const capKey = (manifest) => `${manifest.provider}|${manifest.model}`;
export const outputCap = (manifest) => learnedCaps.get(capKey(manifest)) ?? null;
export const forgetCaps = () => { learnedCaps.clear(); learnedParams.clear(); };

/**
 * Parameters a model turned out not to accept, learned from its own refusal.
 *
 * OpenAI's reasoning models reject `max_tokens` (they want
 * `max_completion_tokens`) and reject any temperature but the default. They are
 * in the model list this tool shows, so a user picks one and every request
 * fails with a 400 that reads like a bug here.
 *
 * Deliberately NOT a list of model ids. A hard-coded list is stale the week it
 * ships — the same reason model ids are never hard-coded anywhere else here —
 * and the provider has just told us exactly what is wrong. So: adapt, remember
 * for this provider and model, and carry on.
 */
const learnedParams = new Map();
export const learnedParamsFor = (manifest) => learnedParams.get(capKey(manifest)) ?? null;

function adaptPayload(payload, params) {
  const out = { ...payload };
  if (params?.maxTokensKey && out.max_tokens !== undefined) {
    out[params.maxTokensKey] = out.max_tokens;
    delete out.max_tokens;
  }
  if (params?.dropTemperature) delete out.temperature;
  return out;
}

/** Which parameter a 400 is complaining about, if it is complaining about one. */
export function unsupportedParam(raw) {
  const text = String(raw ?? '');
  if (/max_completion_tokens/i.test(text)) return 'max_tokens';
  if (/unsupported[^.]*\bmax_tokens\b|\bmax_tokens\b[^.]*(unsupported|not supported)/i.test(text)) return 'max_tokens';
  if (/\btemperature\b/i.test(text) && /(unsupported|not supported|only the default|does not support)/i.test(text)) {
    return 'temperature';
  }
  return null;
}

export function parseProviderError(status, text, headers) {
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const raw = String(body?.error?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : '') ?? '')
    || String(text ?? '').slice(0, 300);
  const code = String(body?.error?.code ?? body?.error?.type ?? '');

  // "... tokens per minute (TPM): Limit 6000, Requested 7120" — Groq, OpenAI.
  const limits = raw.match(/\((\w+)\):\s*Limit\s*([\d,]+),\s*(?:Used\s*([\d,]+),\s*)?Requested\s*([\d,]+)/i);
  const num = (s) => (s ? Number(s.replace(/,/g, '')) : null);
  const unit = limits?.[1]?.toUpperCase() ?? null;
  const limit = num(limits?.[2]);
  const requested = num(limits?.[4]);

  const param = status === 400 || status === 422 ? unsupportedParam(raw + code) : null;
  const retryAfter = retryAfterMs(headers, raw);
  const tooLarge = /request too large|exceeds? the (?:enforced )?limit|context_length_exceeded|maximum context length|too many tokens/i.test(raw)
    || code === 'context_length_exceeded' || status === 413;

  let kind = 'other';
  // Before 'model': a refusal naming a parameter usually also contains the
  // phrase "not supported", which would otherwise read as a dead model.
  if (param) kind = 'param';
  else if (tooLarge) kind = 'too-large';
  else if (status === 429) kind = 'rate-limit';
  else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 404 || /model_not_found|does not exist|not supported|decommissioned/i.test(raw + code)) kind = 'model';
  else if (status >= 500) kind = 'server';

  return { kind, status, unit, limit, requested, retryAfter, param, raw: tidy(raw) };
}

/** The provider's sentence without the organisation id and the sales pitch. */
function tidy(message) {
  return message
    .replace(/\s*in organization `[^`]*`/gi, '')
    .replace(/\s*service tier `[^`]*`/gi, '')
    .replace(/\s*Need more tokens\?.*$/is, '')
    .replace(/\s*Visit https?:\S+.*$/is, '')
    .trim();
}

/** Milliseconds to wait, from Retry-After or from "try again in 1m2.5s". */
function retryAfterMs(headers, message) {
  const header = Number(headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const m = String(message).match(/try again in\s*((?:[\d.]+h)?(?:[\d.]+m(?!s))?(?:[\d.]+s)?(?:[\d.]+ms)?)/i);
  if (!m || !m[1]) return null;
  let ms = 0;
  for (const [, n, u] of m[1].matchAll(/([\d.]+)(h|ms|m|s)/g)) {
    ms += Number(n) * { h: 3600000, m: 60000, s: 1000, ms: 1 }[u];
  }
  return ms || null;
}

const UNIT_NAMES = {
  OTPM: 'output tokens a minute', TPM: 'tokens a minute', RPM: 'requests a minute',
  TPD: 'tokens a day', RPD: 'requests a day', ITPM: 'input tokens a minute',
};

function describeError(info, manifest) {
  const who = providerFor(manifest.provider)?.label ?? manifest.provider;
  const model = manifest.model;
  const per = UNIT_NAMES[info.unit] ?? 'tokens';
  const wait = info.retryAfter ? ` (about ${humanWait(info.retryAfter)})` : '';

  switch (info.kind) {
    case 'too-large':
      return info.limit
        ? `${who} allows ${model} ${info.limit.toLocaleString()} ${per} on your plan, and this request needs ${info.requested?.toLocaleString() ?? 'more'}.\n` +
          `  Pick a model with higher limits (/models), or upgrade your ${who} plan.`
        : `The request is too large for ${model}: ${info.raw}`;
    case 'rate-limit':
      return `${who} rate limit reached for ${model}${info.unit ? ` — ${per}` : ''}${wait}.\n` +
        `  Wait and try again, or pick another model (/models).${info.raw ? `\n  ${who} said: ${info.raw}` : ''}`;
    case 'auth':
      return `${who} refused the API key (${info.status}). Add a working one with /key.`;
    case 'model':
      return `${who} cannot use ${model} for this: ${info.raw}\n  Pick another model with /models.`;
    case 'server':
      return `${who} is having trouble (${info.status}) — try again in a moment.${info.raw ? ` ${info.raw}` : ''}`;
    default:
      return `${who} returned ${info.status}: ${info.raw}`;
  }
}

const humanWait = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.ceil(ms / 1000)}s`);

/**
 * Send one request, recovering from what can be recovered.
 *
 *   - too large, with a number to aim for: shrink max_tokens under the limit,
 *     remember the cap, and resend at once. That is the Groq free tier's
 *     "Limit 1000, Requested 2581" — the request was fine except for asking.
 *   - rate limited: wait as long as the provider says, up to MAX_WAIT_MS, and
 *     say so on screen, so a pause does not read as a hang.
 *   - network errors and 5xx: short backoff, as before.
 *
 * Streaming stops retrying at the first byte: `stream` only ever retries
 * responses that never produced a body.
 */
async function request(manifest, url, headers, body, key, { stream = false, retries = 2, notice = defaultNotice } = {}) {
  let lastError;
  let limitRetries = 0;
  let payload = { ...body };
  const cap = outputCap(manifest);
  if (cap && payload.max_tokens > cap) payload.max_tokens = cap;
  // Whatever this model refused last time, already applied.
  let params = { ...(learnedParams.get(capKey(manifest)) ?? {}) };
  payload = adaptPayload(payload, params);

  for (let attempt = 0; attempt <= retries + limitRetries; attempt++) {
    let res;
    try {
      res = await fetch(url, stream
        ? { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify({ ...payload, stream: true }) }
        : { method: 'POST', headers, body: JSON.stringify(payload) });
    } catch (err) {
      lastError = new Error(redact(err.message, key));
      if (attempt >= retries + limitRetries) throw lastError;
      await sleep(backoff(attempt));
      continue;
    }

    // Every response says what is left of this key's minute, refused or not.
    // The loop fits the next request to it rather than to a fresh minute.
    try { observe(manifest, res.headers); } catch { /* bookkeeping must not fail a request */ }

    if (res.ok) {
      if (!stream) return { json: await res.json() };
      // Some OpenAI-compatible servers ignore `stream: true` and answer with one
      // JSON body. Fed to the SSE parser that has no `data:` lines, so it read
      // as an empty reply — and every task failed with "the model called no
      // tool" even though the model had called one. Read it as JSON instead.
      const type = String(res.headers?.get?.('content-type') ?? '');
      if (/json/i.test(type) && !/event-stream/i.test(type)) return { json: await res.json() };
      if (!res.body) throw new Error('the provider returned no response body to stream');
      return { stream: res.body };
    }

    const text = redact(await res.text(), key);
    const info = parseProviderError(res.status, text, res.headers);
    lastError = new ProviderError(redact(describeError(info, manifest), key), { ...info, provider: manifest.provider, model: manifest.model });

    // Limit recoveries get their own small allowance, so a shrink followed by a
    // wait for the minute to roll over does not use up the network retries.
    if (info.kind === 'param') {
      const next = info.param === 'max_tokens'
        ? { ...params, maxTokensKey: 'max_completion_tokens' }
        : { ...params, dropTemperature: true };
      // Only retry when the adaptation is new, or a model that refuses both
      // would loop refusing one of them.
      const changed = next.maxTokensKey !== params.maxTokensKey || next.dropTemperature !== params.dropTemperature;
      if (!changed || limitRetries >= 2) throw lastError;
      params = next;
      learnedParams.set(capKey(manifest), params);
      payload = adaptPayload({ ...body, ...(payload.max_tokens ? { max_tokens: payload.max_tokens } : {}) }, params);
      limitRetries++;
      continue;
    }

    if (info.kind === 'too-large') {
      // The provider just counted this exact request for us. Its number beats
      // any constant the estimator carries, so the next estimate uses it.
      if (info.requested) {
        calibrate(manifest, { chars: JSON.stringify(payload).length, tokens: info.requested });
      }

      // Shrinking the reply cap cannot help when the input alone is over the
      // limit — that was the loop that burned an attempt: cap 4,000 -> 1,236,
      // refused again at a bigger input. Say which half is too big.
      const output = payload.max_tokens ?? payload.max_completion_tokens ?? 0;
      if (info.limit && info.requested && info.requested - output >= info.limit) {
        throw new ProviderError(
          `${providerFor(manifest.provider)?.label ?? manifest.provider} allows ${info.limit.toLocaleString()} ` +
          `${UNIT_NAMES[info.unit] ?? 'tokens'} for ${manifest.model}, and the conversation alone needs ` +
          `${(info.requested - output).toLocaleString()}.
` +
          '  A smaller reply cap cannot fix this. Read less in one step, or use a model with a higher limit (/models).',
          { ...info, kind: 'too-large', inputOnly: true, provider: manifest.provider, model: manifest.model },
        );
      }

      const smaller = shrink(payload.max_tokens, info);
      if (!smaller || limitRetries >= 2) throw lastError;
      learnedCaps.set(capKey(manifest), smaller);
      notice(`${manifest.model} allows ${info.limit.toLocaleString()} ${UNIT_NAMES[info.unit] ?? 'tokens'} on this plan — replies capped at ${smaller.toLocaleString()} tokens.`);
      payload.max_tokens = smaller;
      limitRetries++;
      continue;
    }

    if (info.kind === 'rate-limit') {
      const wait = info.retryAfter ?? backoff(attempt) * 4;
      // A daily limit, or a wait longer than anyone would sit through, is an
      // answer rather than a pause.
      if (wait > MAX_WAIT_MS || limitRetries >= 3 || /day|TPD|RPD/i.test(info.unit ?? '')) throw lastError;
      notice(`${manifest.model} is rate limited — waiting ${humanWait(wait)} and trying again…`);
      await sleep(wait + 250);
      limitRetries++;
      continue;
    }

    if (!RETRY_STATUS.has(res.status) || attempt >= retries + limitRetries) throw lastError;
    await sleep(info.retryAfter ? Math.min(info.retryAfter, 15000) : backoff(attempt));
  }
  throw lastError;
}

/**
 * A max_tokens that fits under the limit the provider named, or null.
 *
 * For an output limit the answer is just under the limit. For a combined limit
 * (TPM counts input too) it is the current ask minus the overshoot.
 */
function shrink(current, { unit, limit, requested }) {
  if (!limit || !requested || !current) return null;
  let next;
  if (unit === 'OTPM') next = Math.floor(limit * 0.9);
  else next = Math.floor(current - (requested - limit) - 100);
  next = Math.min(next, current - 1);
  return next >= MIN_OUTPUT ? next : null;
}

function defaultNotice(message) {
  // stderr, and on its own line: this can land while a "Designing agents…"
  // line is still open, and must never end up inside piped stdout.
  process.stderr.write(`\n  \x1b[33m…\x1b[0m ${message}\n`);
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
 * Retries stop at the first byte — see request(). Once tokens have been handed
 * to the caller and printed, replaying would duplicate them, so a mid-stream
 * failure is an error, not a retry.
 *
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
export async function callModel(manifest, { system, messages = [], tools, maxTokens, temperature, onDelta, onNotice } = {}) {
  const opts = onNotice ? { notice: onNotice } : {};
  const key = apiKey(manifest);
  if (!key && requiresKey(manifest)) {
    throw new Error(missingKey(manifest.keyEnv));
  }
  const limit = maxTokens ?? manifest.maxTokens ?? 4096;
  const temp = temperature ?? manifest.temperature ?? 0.2;

  if (isAnthropic(manifest)) {
    const url = `${endpoint(manifest)}/v1/messages`;
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
      const res = await request(manifest, url, headers, payload, key, { ...opts, stream: true });
      if (res.stream) return readAnthropicStream(parseSSE(res.stream), (t) => onDelta(redact(t, key)));
      return shown(anthropicResult(res.json), onDelta, key);
    }

    return anthropicResult((await request(manifest, url, headers, payload, key, opts)).json);
  }

  const url = `${endpoint(manifest)}/chat/completions`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  const payload = {
    model: manifest.model,
    max_tokens: limit,
    temperature: temp,
    ...(tools?.length ? { tools: toOpenAITools(tools) } : {}),
    messages: toOpenAIMessages(messages, system),
  };

  if (onDelta) {
    const res = await request(manifest, url, headers, payload, key, { ...opts, stream: true });
    if (res.stream) return readOpenAIStream(parseSSE(res.stream), (t) => onDelta(redact(t, key)));
    return shown(openAIResult(res.json), onDelta, key);
  }

  return openAIResult((await request(manifest, url, headers, payload, key, opts)).json);
}

function anthropicResult(data) {
  const blocks = data?.content ?? [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} })),
    stopReason: data?.stop_reason ?? null,
    raw: data,
  };
}

function openAIResult(data) {
  const message = data?.choices?.[0]?.message ?? {};
  return {
    text: message.content ?? '',
    toolCalls: (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function?.name,
      input: safeParse(call.function?.arguments),
    })),
    stopReason: data?.choices?.[0]?.finish_reason ?? null,
    raw: data,
  };
}

/** A buffered reply that stood in for a stream: show its text once, then return it. */
function shown(result, onDelta, key) {
  if (result.text) onDelta(redact(result.text, key));
  return result;
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
  // Reasoning models (Qwen, DeepSeek) put their thinking in <think> tags ahead
  // of the answer, and it often contains a brace or two of its own.
  const cleaned = String(text ?? '')
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
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
