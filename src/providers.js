/**
 * The providers jr-arch knows how to talk to, and how to recognise their keys.
 *
 * One table, used by init, onboarding, model listing, and the request layer.
 * It exists because the request layer used to fall back to OpenAI's URL for
 * any provider that was not Anthropic — so a Groq key with no base_url set
 * would have been sent to api.openai.com. A provider now always resolves to
 * its own endpoint.
 *
 * Model IDs are deliberately NOT listed here. They are fetched live from the
 * provider with the user's own key, because a hard-coded list is stale the week
 * it ships and would offer models the key cannot use.
 */

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    wire: 'anthropic',
    base: 'https://api.anthropic.com',
    keyEnv: 'ANTHROPIC_API_KEY',
    keyPattern: /^sk-ant-/,
    signup: 'console.anthropic.com',
  },
  groq: {
    label: 'Groq',
    wire: 'openai',
    base: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    keyPattern: /^gsk_/,
    signup: 'console.groq.com/keys',
  },
  openrouter: {
    label: 'OpenRouter',
    wire: 'openai',
    base: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    keyPattern: /^sk-or-/,
    signup: 'openrouter.ai/keys',
  },
  xai: {
    label: 'xAI',
    wire: 'openai',
    base: 'https://api.x.ai/v1',
    keyEnv: 'XAI_API_KEY',
    keyPattern: /^xai-/,
    signup: 'console.x.ai',
  },
  gemini: {
    label: 'Google Gemini',
    // Google's OpenAI-compatible endpoint: same wire format, Bearer auth.
    wire: 'openai',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    keyPattern: /^AIza/,
    signup: 'aistudio.google.com/apikey',
  },
  openai: {
    label: 'OpenAI',
    wire: 'openai',
    base: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    // Checked last among the prefixed ones: `sk-` is also the start of an
    // Anthropic and an OpenRouter key.
    keyPattern: /^sk-/,
    signup: 'platform.openai.com/api-keys',
  },
  ollama: {
    label: 'Ollama (local)',
    wire: 'openai',
    base: 'http://localhost:11434/v1',
    keyEnv: 'OLLAMA_API_KEY',
    keyPattern: null,
    noKey: true,
    signup: 'ollama.com',
  },
  'openai-compatible': {
    label: 'Any OpenAI-compatible endpoint',
    wire: 'openai',
    base: null,
    keyEnv: 'LLM_API_KEY',
    keyPattern: null,
    signup: null,
  },
};

/** Order matters: the most specific prefixes are tried first. */
const DETECT_ORDER = ['anthropic', 'groq', 'openrouter', 'xai', 'gemini', 'openai'];

/**
 * Best guess at which provider a key belongs to, from its prefix.
 *
 * A guess, not a fact — prefixes are a convention, not a contract. Callers
 * confirm it by actually listing models with the key, which is the only thing
 * that proves the key and the provider go together.
 */
export function detectProvider(key) {
  const k = String(key ?? '').trim();
  if (!k) return null;
  return DETECT_ORDER.find((id) => PROVIDERS[id].keyPattern?.test(k)) ?? null;
}

export function providerFor(id) {
  return PROVIDERS[id] ?? null;
}

/**
 * The endpoint to use for a manifest: its own base_url if set, otherwise the
 * provider's. Null only for `openai-compatible`, which has no default and must
 * be told where to go.
 */
export function baseUrlFor(provider, baseUrl = null) {
  if (baseUrl) return String(baseUrl).replace(/\/$/, '');
  return PROVIDERS[provider]?.base ?? null;
}

export function wireFor(provider) {
  return PROVIDERS[provider]?.wire ?? 'openai';
}

// ---------------------------------------------------------------------------
// Listing models
// ---------------------------------------------------------------------------

/**
 * Models the key can actually use, fetched from the provider.
 *
 * This doubles as the key check. A 401 here means the key is wrong, and it is
 * far better to find that out while setting up than on the first task. It is a
 * call to the user's own configured provider with the user's own key, which is
 * the one kind of network traffic this tool permits itself.
 *
 * `fetchImpl` is injectable so tests never touch the network.
 *
 * `onHeaders` hands the response headers to the caller. Providers report this
 * key's rate limits there, so the call that proves the key also reveals what
 * the key may spend — free, on a request we were making anyway.
 */
export async function listModels(provider, key, { baseUrl = null, fetchImpl = fetch, timeout = 15000, onHeaders = null } = {}) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`Unknown provider "${provider}".`);

  const base = baseUrlFor(provider, baseUrl);
  if (!base) throw new Error(`${spec.label} needs a base URL.`);

  const anthropic = spec.wire === 'anthropic';
  // Anthropic paginates at 20 by default; ask for everything in one page.
  const url = anthropic ? `${base}/v1/models?limit=1000` : `${base}/models`;
  const headers = anthropic
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : (key ? { authorization: `Bearer ${key}` } : {});

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: controller.signal });
  } catch (e) {
    throw new Error(
      e.name === 'AbortError'
        ? `${spec.label} did not answer within ${timeout / 1000}s.`
        : `Could not reach ${spec.label} (${e.message}).`,
    );
  } finally {
    clearTimeout(timer);
  }

  try { onHeaders?.(res.headers); } catch { /* reporting limits must never fail the key check */ }

  if (res.status === 401 || res.status === 403) {
    throw new KeyRejected(`${spec.label} rejected that key (${res.status}).`);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    // Google answers a bad key with 400 INVALID_ARGUMENT, not 401. Reading it
    // as a server error told the user to try again later with the same key.
    if (res.status === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(detail)) {
      throw new KeyRejected(`${spec.label} rejected that key (${res.status}).`);
    }
    throw new Error(`${spec.label} returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const body = await res.json();
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return rows
    .map((m) => ({
      // Gemini lists "models/gemini-2.5-flash". Chat requests take the bare
      // name, and it is the one people recognise.
      id: String(m.id ?? m.name ?? '').replace(/^models\//, ''),
      label: m.display_name ?? m.name ?? m.id,
      created: m.created ?? (m.created_at ? Date.parse(m.created_at) / 1000 : 0),
      owner: m.owned_by ?? null,
    }))
    .filter((m) => m.id)
    .filter((m) => isChatModel(m.id))
    // Newest first: the model someone most likely wants is the latest one.
    .sort((a, b) => (b.created || 0) - (a.created || 0) || a.id.localeCompare(b.id));
}

/** A key the provider refused, as opposed to one it could not be asked about. */
export class KeyRejected extends Error {}

/**
 * Drop models that cannot drive a coding agent.
 *
 * Provider model lists include speech-to-text, text-to-speech, embeddings,
 * moderation, and image models. None of them can call a tool, so offering them
 * as the model for a coding agent is offering a guaranteed failure.
 */
export function isChatModel(id) {
  // orpheus is Groq's text-to-speech model; its id has no "tts" in it. aqa,
  // veo and lyria are Gemini's attributed-answer, video and music models
  // (imagen is caught by "image").
  return !/whisper|tts|embed|moderation|guard|dall-e|image|audio|transcri|realtime|search-preview|playai|orpheus|\baqa\b|\bveo\b|lyria/i.test(id);
}
