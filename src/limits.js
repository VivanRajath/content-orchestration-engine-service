import { join } from 'node:path';
import { agentDir } from './paths.js';
import { readManifest, modelFor, setTierMaxTokens, clearTierMaxTokens, setModelMaxTokens } from './config.js';
import { readAgents } from './agents.js';
import { PROVIDERS, providerFor, baseUrlFor, wireFor } from './providers.js';
import { c, ok, info, warn } from './util.js';

/**
 * What the provider will let this key do, and what the agents are allowed to
 * ask for.
 *
 * Two different numbers, routinely confused, so both are shown together:
 *
 *   provider limits   requests and tokens per minute or day, set by the plan
 *                     the key belongs to. Read from the provider's own
 *                     response headers — never guessed and never hard-coded,
 *                     because every tier of every provider has different ones.
 *   reply cap         `max_tokens`, the ceiling on one reply. Ours to choose,
 *                     per agent. Too high and a free-tier key refuses the
 *                     request outright ("Limit 1000, Requested 2581"); too low
 *                     and the model is cut off mid tool call.
 *
 * Rate-limit headers come back on ordinary responses, including error ones, so
 * a 429 is as good a source as a 200. That is why probeLimits reads the headers
 * of whatever came back rather than only of a success.
 */

// Each family names the same quantities differently, and in a different order:
// OpenAI-shaped is <prefix>-<part>-<suffix>, Anthropic is <prefix>-<suffix>-<part>.
// Anthropic also splits input from output, where the others report one combined
// token count.
const FAMILIES = [
  {
    prefix: 'x-ratelimit',
    name: (prefix, part, suffix) => `${prefix}-${part}-${suffix}`,
    rows: [
      { key: 'requests', label: 'requests', suffix: 'requests' },
      { key: 'tokens', label: 'tokens', suffix: 'tokens' },
    ],
  },
  {
    prefix: 'anthropic-ratelimit',
    name: (prefix, part, suffix) => `${prefix}-${suffix}-${part}`,
    rows: [
      { key: 'requests', label: 'requests', suffix: 'requests' },
      { key: 'tokens', label: 'tokens', suffix: 'tokens' },
      { key: 'input', label: 'input tokens', suffix: 'input-tokens' },
      { key: 'output', label: 'output tokens', suffix: 'output-tokens' },
    ],
  },
];

const read = (headers, name) => {
  if (!headers) return null;
  const value = typeof headers.get === 'function'
    ? headers.get(name)
    : headers[name] ?? headers[name.toLowerCase()];
  return value == null || value === '' ? null : String(value);
};

const number = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[,_]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Normalise whatever rate-limit headers a provider sent.
 *
 * Returns `{found, rows}` rather than throwing on an unknown shape: a provider
 * that reports nothing is a normal case — Ollama, and most OpenAI-compatible
 * servers — not an error, and the caller says so in one line instead of
 * inventing numbers.
 */
export function parseRateLimits(headers) {
  const rows = [];
  for (const family of FAMILIES) {
    for (const spec of family.rows) {
      if (rows.some((r) => r.key === spec.key)) continue;
      const limit = number(read(headers, family.name(family.prefix, 'limit', spec.suffix)));
      const remaining = number(read(headers, family.name(family.prefix, 'remaining', spec.suffix)));
      const reset = read(headers, family.name(family.prefix, 'reset', spec.suffix));
      if (limit == null && remaining == null) continue;
      rows.push({ key: spec.key, label: spec.label, limit, remaining, reset: humanReset(reset) });
    }
  }
  // Retry-After is not a limit, but when a key is already throttled it is the
  // only honest thing we can say about when it will work again.
  const retry = read(headers, 'retry-after');
  return { found: rows.length > 0, rows, retryAfter: retry ? humanReset(retry) : null };
}

/**
 * Resets arrive as seconds ("60"), as a duration ("2m59.56s"), or as an
 * absolute RFC3339 timestamp (Anthropic). All three are shown as "in ...".
 */
export function humanReset(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return `in ${duration(seconds * 1000)}`;

  if (/^[\d.]/.test(raw) && /(ms|[hms])/.test(raw)) {
    let ms = 0;
    for (const [, n, u] of raw.matchAll(/([\d.]+)(ms|h|m|s)/g)) {
      ms += Number(n) * { h: 3600000, m: 60000, s: 1000, ms: 1 }[u];
    }
    if (ms > 0) return `in ${duration(ms)}`;
  }

  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    const ms = at - Date.now();
    return ms > 0 ? `in ${duration(ms)}` : 'now';
  }
  return raw;
}

function duration(ms) {
  if (ms < 1000) return 'under a second';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
  return `${Math.round(ms / 3600000)}h`;
}

/**
 * Ask the provider what this key's limits are, with the smallest request that
 * still counts as one: a single output token.
 *
 * The reply is thrown away and only the headers are kept. An error response is
 * just as useful, because it carries the same headers — so a key that is
 * already throttled reports its limits instead of reporting nothing.
 */
export async function probeLimits({
  provider, model, key = '', baseUrl = null, fetchImpl = fetch, timeout = 15000,
} = {}) {
  const spec = PROVIDERS[provider];
  if (!spec) return { found: false, rows: [], note: `Unknown provider "${provider}".` };
  if (spec.noKey) return { found: false, rows: [], note: `${spec.label} runs locally — there is no account limit to report.` };

  const base = baseUrlFor(provider, baseUrl);
  if (!base) return { found: false, rows: [], note: `No base URL is set for ${spec.label}.` };
  if (!model) return { found: false, rows: [], note: 'No model is configured yet.' };

  const anthropic = wireFor(provider) === 'anthropic';
  const url = anthropic ? `${base}/v1/messages` : `${base}/chat/completions`;
  const headers = anthropic
    ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: `Bearer ${key}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    });
  } catch (e) {
    return {
      found: false,
      rows: [],
      note: e.name === 'AbortError'
        ? `${spec.label} did not answer within ${timeout / 1000}s.`
        : `Could not reach ${spec.label} (${e.message}).`,
    };
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseRateLimits(res.headers);
  if (parsed.found) return parsed;
  return {
    ...parsed,
    note: res.status === 401 || res.status === 403
      ? `${spec.label} refused the key (${res.status}).`
      : `${spec.label} reports no rate-limit headers for ${model}.`,
  };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export const DEFAULT_CAP = 4096;

const count = (n) => (n == null ? '—' : n.toLocaleString());

export function printProviderLimits(limits, { provider, model } = {}) {
  const who = providerFor(provider)?.label ?? provider ?? 'provider';
  console.log(`  ${c.b('Provider limits')}  ${c.d(`${who}${model ? ` · ${model}` : ''}`)}`);
  if (!limits?.found) {
    info(`  ${c.d(limits?.note ?? 'nothing reported')}`);
    return;
  }
  for (const row of limits.rows) {
    const left = row.remaining == null ? '' : c.d(`   ${count(row.remaining)} left`);
    const when = row.reset ? c.d(` · resets ${row.reset}`) : '';
    info(`  ${row.label.padEnd(14)}${count(row.limit).padStart(9)}${left}${when}`);
  }
  if (limits.retryAfter) warn(`  this key is throttled right now — it frees up ${limits.retryAfter}`);
}

/** The reply cap each agent runs under, and whether it set its own. */
export function agentCaps(manifest, agents) {
  return agents.map((a) => {
    const m = modelFor(manifest, a.name);
    const own = manifest.tiers?.[a.name]?.model?.max_tokens;
    return {
      name: a.name,
      model: m.model,
      maxTokens: m.maxTokens ?? DEFAULT_CAP,
      inherited: own == null,
    };
  });
}

export function printAgentCaps(manifest, agents) {
  console.log(`  ${c.b('Reply cap')}  ${c.d('max_tokens — the most one reply may generate')}`);
  info(`  ${'default'.padEnd(16)}${count(manifest.maxTokens ?? DEFAULT_CAP).padStart(9)}  ${c.d(manifest.model ?? '')}`);
  for (const row of agentCaps(manifest, agents)) {
    const note = row.inherited ? c.d('(inherits)') : c.d(row.model);
    info(`  ${c.c(row.name.padEnd(16))}${count(row.maxTokens).padStart(9)}  ${note}`);
  }
}

/**
 * A cap that fits under what the provider just said this key may spend.
 *
 * A free tier rejects a request that merely ASKS for more output tokens than
 * the allowance, so the useful advice is not "wait" but "ask for less".
 *
 * An output-specific limit is the direct answer, with 10% left for a request
 * already in flight. A combined limit counts the prompt too, so half of it is
 * the most a single reply can sensibly claim — the other half has to carry the
 * agent's system prompt, the file it just read, and the tool results.
 */
export function suggestedCap(limits) {
  const output = limits?.rows?.find((r) => r.key === 'output') ?? null;
  if (output?.limit) return Math.max(400, Math.floor(output.limit * 0.9));

  const combined = limits?.rows?.find((r) => r.key === 'tokens') ?? null;
  if (combined?.limit) return Math.max(400, Math.floor(combined.limit * 0.5));

  return null;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function showLimits({ dir = agentDir(), fetchImpl = fetch, probe = true } = {}) {
  const manifest = readManifest(join(dir, 'agent.yaml'));
  const agents = readAgents(dir);

  console.log();
  let limits = { found: false, rows: [], note: 'not checked (--offline)' };
  if (probe) {
    process.stdout.write(`  ${c.d('Asking the provider what this key may use...')} `);
    limits = await probeLimits({
      provider: manifest.provider,
      model: manifest.model,
      key: process.env[manifest.keyEnv] ?? '',
      baseUrl: manifest.baseUrl,
      fetchImpl,
    });
    console.log(limits.found ? c.g('answered') : c.y('nothing reported'));
    console.log();
  }

  printProviderLimits(limits, { provider: manifest.provider, model: manifest.model });
  console.log();
  printAgentCaps(manifest, agents);

  const suggested = suggestedCap(limits);
  if (suggested && (manifest.maxTokens ?? DEFAULT_CAP) > suggested) {
    console.log();
    warn(`The reply cap (${count(manifest.maxTokens ?? DEFAULT_CAP)}) is higher than this key's output allowance.`);
    info('A request that asks for more than the limit is refused outright, not queued.');
    info(`Lower it:  ${c.c(`jr-arch limits set default ${suggested}`)}`);
  }
  console.log();
  return { manifest, agents, limits };
}

const HELP = [
  'Usage:',
  '  jr-arch limits                    provider limits, and each agent’s reply cap',
  '  jr-arch limits set <agent> <n>    cap one agent’s replies at n tokens',
  '  jr-arch limits set default <n>    change the cap every agent inherits',
  '  jr-arch limits unset <agent>      go back to inheriting the default',
].join('\n');

export async function limits(positional, flags = {}, { fetchImpl = fetch } = {}) {
  const dir = agentDir();
  const [action, target, value] = positional ?? [];

  if (!action || action === 'show') {
    await showLimits({ dir, fetchImpl, probe: !flags.offline });
    info(c.d('set one:  jr-arch limits set <agent> <tokens>'));
    console.log();
    return;
  }

  if (action === 'set') {
    if (!target || value === undefined) throw new Error(HELP);
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`"${value}" is not a token count.\n\n${HELP}`);

    if (target === 'default') {
      setModelMaxTokens(n);
      ok(`Every agent may now generate up to ${c.c(count(n))} tokens per reply.`);
      return;
    }

    const installed = readAgents(dir);
    if (!installed.some((a) => a.name === target)) {
      throw new Error(`No agent "${target}". Installed: ${installed.map((a) => a.name).join(', ') || 'none'}`);
    }
    setTierMaxTokens(target, n);
    ok(`${c.c(target)} may now generate up to ${c.c(count(n))} tokens per reply.`);
    return;
  }

  if (action === 'unset') {
    if (!target) throw new Error(HELP);
    if (clearTierMaxTokens(target)) ok(`${c.c(target)} inherits the default cap again.`);
    else warn(`${target} had no cap of its own.`);
    return;
  }

  throw new Error(`Unknown limits action "${action}".\n\n${HELP}`);
}
