/**
 * What a request will cost, worked out before it is sent.
 *
 * The loop used to send whatever had accumulated and let the provider decide.
 * On a key with a small per-minute allowance that is not a slow start, it is a
 * wall: reading one 7,300-token README on an 8,000-token-a-minute key produced
 * "Limit 8000, Requested 10,664" — and the recovery shrank the reply cap, which
 * is the half that was not the problem. The input kept growing, so the retry
 * failed at 10,733 and the attempt was spent for nothing.
 *
 * So: estimate locally, fit the request to what the key allows, and say so.
 *
 * The estimate is characters over a ratio, not a tokenizer. A real tokenizer is
 * a dependency, this project has none, and the decision being made — "does this
 * fit, and what has to go" — survives a 15% error. Where the provider tells us
 * the true count in a rejection, that is worth more than any constant, so
 * `calibrate()` learns the real ratio per model and later estimates use it.
 */

/**
 * Conservative on purpose. English prose runs about 4 characters per token,
 * code and JSON denser. Underestimating means a request we thought would fit is
 * refused, which costs an attempt; overestimating only trims a little early.
 */
const DEFAULT_CHARS_PER_TOKEN = 3.6;

/** Role, delimiters and the JSON wrapper each message carries on the wire. */
const PER_MESSAGE = 4;

/** Never promise the model less than this much room to answer in. */
export const MIN_OUTPUT = 400;

/**
 * Held back from every budget: our count and the provider's will not agree
 * exactly, and being 3% under the limit is free while being 1% over is a failed
 * request.
 */
const SAFETY = 0.05;
const SAFETY_FLOOR = 150;

const ratios = new Map();
const key = (manifest) => `${manifest?.provider ?? '?'}|${manifest?.model ?? '?'}`;

/** What one character costs on this model, as last observed. */
export function charsPerToken(manifest) {
  return ratios.get(key(manifest)) ?? DEFAULT_CHARS_PER_TOKEN;
}

/**
 * Learn the real ratio from a rejection that names the true token count.
 *
 * A provider that refuses a request tells us exactly what it counted. That is
 * ground truth for this model's tokenizer, and it is free.
 */
export function calibrate(manifest, { chars, tokens }) {
  if (!chars || !tokens || tokens <= 0) return null;
  const observed = chars / tokens;
  // Ignore an implausible ratio: a garbled or partial error message should not
  // teach the estimator that a token is half a character.
  if (observed < 1.5 || observed > 12) return null;
  ratios.set(key(manifest), observed);
  return observed;
}

export const forgetRatios = () => ratios.clear();

export function estimateTokens(text, manifest) {
  const chars = String(text ?? '').length;
  return chars ? Math.ceil(chars / charsPerToken(manifest)) : 0;
}

/** The characters one provider-neutral message puts on the wire. */
export function messageChars(m) {
  if (!m) return 0;
  if (m.role === 'user') return String(m.content ?? '').length;
  if (m.role === 'assistant') {
    const calls = (m.toolCalls ?? []).reduce(
      (n, call) => n + String(call.name ?? '').length + JSON.stringify(call.input ?? {}).length,
      0,
    );
    return String(m.text ?? '').length + calls;
  }
  return (m.results ?? []).reduce((n, r) => n + String(r.content ?? '').length, 0);
}

/** Everything the next request will carry, in tokens. */
export function estimateRequest({ system = '', messages = [], tools = null, manifest = null } = {}) {
  let chars = String(system ?? '').length;
  for (const m of messages) chars += messageChars(m) + PER_MESSAGE * charsPerToken(manifest);
  if (tools?.length) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / charsPerToken(manifest));
}

/**
 * The most one request may spend, from what the key actually allows.
 *
 * `tokens_per_minute` is written into agent.yaml at setup, from the provider's
 * own rate-limit headers. A minute's allowance is shared with whatever else the
 * run does in that minute, but a single request is where the hard failure
 * happens, so the ceiling is most of the minute rather than a slice of it —
 * being unable to read a file at all is worse than waiting for the next minute.
 */
export function budgetFor(manifest) {
  const declared = manifest?.raw?.model?.tokens_per_minute ?? manifest?.tokensPerMinute ?? null;
  const tpm = Number(declared);
  if (!Number.isFinite(tpm) || tpm <= 0) return null;
  return Math.max(MIN_OUTPUT * 2, Math.floor(tpm * 0.9));
}

/** How much of a budget a tool result may take, so a reply still fits beside it. */
export function readCeiling(budget, manifest) {
  const chars = charsPerToken(manifest);
  // With no budget to work from, a ceiling still has to exist: 200,000
  // characters is 50,000 tokens, more than an entire minute on a small key and
  // more than most models will accept in one message.
  if (!budget) return Math.round(100000);
  return Math.max(2000, Math.round(budget * 0.35 * chars));
}

const margin = (budget) => Math.max(SAFETY_FLOOR, Math.round(budget * SAFETY));

export const formatTokens = (n) =>
  (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

/**
 * Make the request fit, and say what it cost to do so.
 *
 * Order matters. The reply cap is reduced first, because a shorter answer still
 * answers. Only when there is no room left to reply in does history go, oldest
 * tool result first: file contents are the bulk of a transcript, the task and
 * the most recent turns are what the model is actually working from, and a
 * trimmed result can be read again. What is dropped is replaced by a note
 * saying so — a model that cannot see that something was removed will assume it
 * remembers the file correctly.
 *
 * Mutates the messages it trims: the next request in the same attempt would
 * otherwise carry the same weight again.
 */
export function fit({
  system = '', messages = [], tools = null, maxTokens = null, budget = null, manifest = null,
} = {}) {
  const wanted = maxTokens ?? MIN_OUTPUT;
  const input = estimateRequest({ system, messages, tools, manifest });

  if (!budget) return { fits: true, input, maxTokens: wanted, trimmed: [], budget: null };

  const room = budget - margin(budget);
  const fixed = estimateRequest({ system, messages: [], tools, manifest });

  // The prompt alone is over the limit. No trimming reaches it — the agent's
  // own identity and the tool schemas are not optional — so this is a fact
  // about the key, reported as one.
  if (fixed + MIN_OUTPUT > room) {
    return {
      fits: false,
      input,
      maxTokens: MIN_OUTPUT,
      trimmed: [],
      budget,
      reason:
        `this agent's prompt and tools are ~${formatTokens(fixed)} tokens, and the key allows ` +
        `~${formatTokens(budget)} per request. There is no room left to work in.`,
    };
  }

  const trimmed = [];
  let used = input;

  // Oldest first, and never the opening task or the two most recent turns.
  for (let i = 1; i < messages.length - 2 && used + MIN_OUTPUT > room; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    for (const result of m.results ?? []) {
      const size = String(result.content ?? '').length;
      if (size < 400 || result.trimmed) continue;
      const cost = Math.ceil(size / charsPerToken(manifest));
      result.content =
        `[${formatTokens(cost)} tokens of earlier ${result.name ?? 'tool'} output were dropped to fit ` +
        'this key’s per-minute limit. Read it again, in smaller pieces, if you still need it.]';
      result.trimmed = true;
      trimmed.push({ name: result.name ?? 'tool', tokens: cost });
      used -= cost - estimateTokens(result.content, manifest);
    }
  }

  const available = room - used;
  const allowed = Math.max(MIN_OUTPUT, Math.min(wanted, available));

  return {
    fits: used + MIN_OUTPUT <= room,
    input: used,
    maxTokens: allowed,
    trimmed,
    budget,
    reason: used + MIN_OUTPUT > room
      ? `the conversation is ~${formatTokens(used)} tokens and the key allows ~${formatTokens(budget)} per request.`
      : null,
  };
}

/**
 * One line for a person: what a step costs, and what the key allows.
 *
 * Shown before the first request rather than after the first failure, which is
 * the whole point — "about 3 steps a minute" is something you can act on, and a
 * 429 twenty seconds in is not.
 */
export function describeBudget({ input, budget, maxTokens }) {
  if (!budget) return `~${formatTokens(input)} tokens per step`;
  const perMinute = Math.round(budget / 0.9);
  const steps = Math.max(1, Math.floor(perMinute / Math.max(1, input + maxTokens)));
  return (
    `~${formatTokens(input)} per step · ${formatTokens(perMinute)}/min on this key · ` +
    `about ${steps} step${steps === 1 ? '' : 's'} a minute`
  );
}
