import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir, repoRoot } from './paths.js';
import { init } from './init.js';
import { readManifest, patchSection, setModelMaxTokens, setTokensPerMinute } from './config.js';
import { writeKey, ensureIgnored, fingerprint } from './env.js';
import { PROVIDERS, detectProvider, providerFor, listModels, KeyRejected } from './providers.js';
import { parseRateLimits, probeModel, printProviderLimits, suggestedCap } from './limits.js';
import { printTree } from './tree.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { c, ok, info, warn } from './util.js';

/**
 * First run.
 *
 * Someone who just typed `npx jr-arch` has no .gitagent/, no key, and no idea
 * what either is. So instead of an error telling them to go and run three
 * other commands, this walks them through it one step at a time: paste a key,
 * see that it works, pick a model the key can actually reach, watch the folder
 * appear, and choose how to start.
 *
 * Every question goes through a prompter, so the whole flow is scriptable in a
 * test. Every network call goes through an injectable fetch, so none of it
 * needs a real key to verify.
 */

const STEPS = 4;
const step = (n, title) => {
  console.log();
  console.log(`  ${c.d(`Step ${n} of ${STEPS}`)}  ${c.b(title)}`);
};

export async function onboard(prompter, { fetchImpl = fetch, root = repoRoot() } = {}) {
  console.log();
  console.log(`  ${c.b('Welcome to jr-arch')}`);
  console.log(`  ${c.d('This sets up a coding agent in this repository.')}`);
  console.log(`  ${c.d('Nothing leaves your machine except calls to the AI provider you choose.')}`);

  // --- 1. key ---------------------------------------------------------------
  step(1, 'Connect an AI provider');
  const conn = await obtainKey(prompter, { fetchImpl });
  if (!conn) return null;

  // --- 2. model -------------------------------------------------------------
  step(2, 'Choose a model');
  let model = null;
  let limits = conn.limits ?? { found: false, rows: [] };
  for (;;) {
    model = await pickModel(prompter, conn);
    if (!model) return null;

    // One 1-token request answers both questions worth asking before the first
    // task: what this key may spend, and whether this model can call a tool at
    // all. A model that cannot is not a slow start, it is a dead end — every
    // agent here works through tools.
    const check = await probeModel({ provider: conn.provider, model, key: conn.key, baseUrl: conn.baseUrl, fetchImpl });
    if (check.limits?.found) limits = check.limits;
    else if (!limits.found && check.note) limits = { ...limits, note: check.note };

    console.log();
    printProviderLimits(limits, { provider: conn.provider, model });
    if (await keepModel(prompter, model, check)) break;
  }
  const cap = suggestedCap(limits);

  // --- 3. scaffold ----------------------------------------------------------
  step(3, 'Create your agent folder');
  const dir = agentDir();
  const exists = existsSync(join(dir, 'agent.yaml'));
  if (exists) {
    info('.gitagent/ already exists — keeping your agents, updating the model.');
    setModel({ provider: conn.provider, model, keyEnv: conn.keyEnv, baseUrl: conn.baseUrl });
  } else {
    await init({ provider: conn.provider, model, 'base-url': conn.baseUrl ?? undefined, quiet: true });
  }

  // A reply cap above the key's own output allowance is not ambitious, it is
  // broken: the provider refuses a request that merely ASKS for more, so every
  // task would fail until someone found the number. Fit it to the key now,
  // while we have just been told what the key allows.
  // The per-minute allowance is what every later request is fitted against.
  // Without it the loop can only find out by being refused.
  const perMinute = limits.rows?.find((r) => r.key === 'tokens')?.limit
    ?? limits.rows?.find((r) => r.key === 'input')?.limit
    ?? null;
  if (perMinute) setTokensPerMinute(perMinute, join(dir, 'agent.yaml'));

  const configured = readManifest(join(dir, 'agent.yaml')).maxTokens;
  const capped = cap && (configured == null || cap < configured);
  if (capped) setModelMaxTokens(cap, join(dir, 'agent.yaml'));

  if (conn.key) {
    ensureIgnored(root);
    writeKey(conn.keyEnv, conn.key);
    // Make it live for the rest of this process — onboarding hands straight
    // into a chat that is about to use it.
    process.env[conn.keyEnv] = conn.key;
  }

  ok(`Created ${c.c('.gitagent/')}`);
  printTree(dir);
  explainFiles(conn);

  if (capped) {
    info(`Replies are capped at ${c.c(cap.toLocaleString())} tokens ${c.d('— under what this key allows')}`);
  }
  info(c.d('See or change that with /limits, or jr-arch limits.'));
  console.log();

  // --- 4. mode --------------------------------------------------------------
  step(4, 'How do you want to start?');
  const mode = await prompter.choose('', [
    { value: 'prompt', label: `${c.c('/prompt')}  describe what you need`, note: 'agents are written for you' },
    { value: 'dev', label: `${c.c('/dev')}     write your own agents`, note: 'and set guardrails by hand' },
    { value: 'chat', label: `${c.c('/chat')}    start with the default agents`, note: 'and edit code now' },
  ]);

  return { ...conn, model, mode: mode ?? 'chat', dir };
}

// ---------------------------------------------------------------------------
// Steps, reusable on their own — `/key` and `/models` in the chat call these
// ---------------------------------------------------------------------------

/**
 * Get a key, work out whose it is, and prove it works by listing models.
 *
 * Listing models is the key check. A rejected key is reported here, while the
 * person is still looking at the prompt and can paste it again, rather than as
 * a 401 on their first real task.
 */
export async function obtainKey(prompter, { fetchImpl = fetch, attempts = 3 } = {}) {
  info(`Paste an API key. ${c.d('Supported: Anthropic, Groq, OpenAI, OpenRouter, xAI — or type')} ${c.c('ollama')} ${c.d('for a local model.')}`);

  for (let tries = 0; tries < attempts; tries++) {
    const raw = await prompter.secret('API key:');
    if (raw === null) return null;
    const entered = raw.trim();
    if (!entered) { warn('Nothing entered.'); continue; }

    let provider;
    let key = entered;
    let baseUrl = null;

    if (/^ollama$/i.test(entered)) {
      provider = 'ollama';
      key = '';
      baseUrl = await prompter.ask('Ollama address:', { default: PROVIDERS.ollama.base });
    } else {
      provider = detectProvider(entered);
      if (provider) {
        ok(`That looks like a ${c.b(PROVIDERS[provider].label)} key ${c.d(fingerprint(entered))}`);
      } else {
        info("I can't tell whose key that is from its format.");
        provider = await prompter.choose('Which provider is it for?', [
          ...['anthropic', 'groq', 'openai', 'openrouter', 'xai'].map((id) => ({ value: id, label: PROVIDERS[id].label })),
          { value: 'openai-compatible', label: 'Something else (OpenAI-compatible)' },
        ]);
        if (provider === null) return null;
        if (provider === 'openai-compatible') {
          baseUrl = await prompter.ask('Its base URL (e.g. https://api.together.xyz/v1):');
          if (!baseUrl) { warn('A base URL is needed for that provider.'); continue; }
        }
      }
    }

    process.stdout.write(`  ${c.d('Checking the key…')} `);
    let seenHeaders = null;
    try {
      const models = await listModels(provider, key, { baseUrl, fetchImpl, onHeaders: (h) => { seenHeaders = h; } });
      console.log(c.g('works'));
      if (!models.length) {
        warn('The key works, but no chat models came back. You can still type a model name.');
      } else {
        ok(`${models.length} model${models.length === 1 ? '' : 's'} available`);
      }
      return { provider, key, baseUrl, keyEnv: providerFor(provider).keyEnv, models, limits: parseRateLimits(seenHeaders) };
    } catch (e) {
      console.log(c.r('failed'));
      if (e instanceof KeyRejected) {
        warn(e.message);
        const where = providerFor(provider)?.signup;
        if (where) info(`Get or check a key at ${c.c(where)}`);
      } else {
        warn(e.message);
        // Not a rejected key — the network, a typo'd URL, a local server that
        // is not running. Offer to keep the key anyway rather than trapping
        // someone who is offline in a loop they cannot pass.
        if (await prompter.confirm('Save this key anyway and pick a model by name?', false)) {
          return { provider, key, baseUrl, keyEnv: providerFor(provider).keyEnv, models: [], limits: parseRateLimits(null) };
        }
      }
    }
  }

  warn('Giving up after three tries. Run `jr-arch` again whenever you have a key.');
  return null;
}

/**
 * Report a model that cannot drive an agent, and ask whether to pick another.
 *
 * Only a refusal we understood stops anyone: `supportsTools === false`. A rate
 * limit or an unreachable endpoint says nothing about the model, and refusing
 * to continue on a maybe would be worse than the problem.
 */
export async function keepModel(prompter, model, check) {
  if (check?.supportsTools !== false) return true;

  warn(`${model} cannot call tools, so it cannot drive an agent.`);
  if (check.reason) info(c.d(`  ${check.reason}`));
  info(c.d('  Every agent here reads and writes through tools, so every task would fail.'));
  return !(await prompter.confirm('Pick a different model?', true));
}

/** Choose from what the key can reach, or type a name when the list is empty. */
export async function pickModel(prompter, { models, provider }) {
  if (!models?.length) {
    const typed = await prompter.ask(`Model name for ${PROVIDERS[provider]?.label ?? provider}:`);
    return typed || null;
  }

  // A long list is unreadable in a terminal. Show the newest few and let the
  // rest be typed — the one someone wants is almost always near the top.
  const SHOWN = 12;
  const options = models.slice(0, SHOWN).map((m) => ({
    value: m.id,
    label: m.id,
    note: m.label && m.label !== m.id ? m.label : '',
  }));
  if (models.length > SHOWN) {
    options.push({ value: '__other', label: c.d(`another model (${models.length - SHOWN} more)`) });
  }

  const picked = await prompter.choose('Pick the model your agents will use:', options);
  if (picked !== '__other') return picked;

  const typed = await prompter.ask('Model name:');
  if (typed && !models.some((m) => m.id === typed)) {
    warn(`${typed} was not in the list the key returned — using it anyway.`);
  }
  return typed || null;
}

/**
 * Point an existing manifest at a new provider and model.
 *
 * Section-scoped writes, never a file-wide replace: `name:` appears under both
 * `metadata:` and `model:`, and replacing the wrong one already happened once.
 */
export function setModel({ provider, model, keyEnv, baseUrl = null }) {
  const file = join(agentDir(), 'agent.yaml');
  let text = readFileSync(file, 'utf8');
  for (const [k, v] of [['provider', provider], ['name', model], ['api_key_env', keyEnv], ['base_url', baseUrl ?? 'null']]) {
    text = patchSection(text, 'model', k, v);
  }
  writeFileSync(file, text);
  return readManifest(file);
}

function explainFiles(conn) {
  info(`${c.b('Where things are')}`);
  info(`  ${c.c('agents/<name>/SOUL.md')}   who an agent is, and what it owns`);
  info(`  ${c.c('agents/<name>/RULES.md')}  what it must and must not do`);
  info(`  ${c.c('hooks/')}                  guardrails — enforced, not suggested`);
  info(`  ${c.c('agent.yaml')}              model and routing`);
  if (conn.key) {
    info(`  ${c.c('.env')}                    your key ${c.d('— gitignored, and the agents cannot read it')}`);
  }
  console.log();
}
