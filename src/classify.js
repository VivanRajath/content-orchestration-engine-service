import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './paths.js';
import { callModel, extractJson } from './provider.js';

/**
 * Tier selection. One model call returning strict JSON {tier, confidence,
 * reason}, per DUTIES.md.
 *
 * Entry tier comes from repo state and task shape, never from language or
 * framework — a CSS tweak in a Go repo is still ui-editor work — so the prompt
 * carries the user's own DUTIES.md entry rules rather than a copy of them
 * baked in here. DUTIES.md is the contract; this file only routes.
 */

/**
 * Where a low-confidence classification goes. Over-qualifying costs tokens;
 * under-qualifying costs a thrash loop, so the bump is always upward.
 *
 * ui-editor bumps to junior-dev, not senior-dev: they are peers split by
 * domain, and a low-confidence "this is presentational" most likely means
 * mixed logic work, which is junior's. build-doctor does not bump at all —
 * routing out of it on a red build contradicts DUTIES.md entry rule 1.
 */
const LADDER = {
  'build-doctor': 'build-doctor',
  'ui-editor': 'junior-dev',
  'junior-dev': 'senior-dev',
  'senior-dev': 'senior-dev',
};

const MAX_FILES = 300;

const SYSTEM = `You classify a coding task to exactly one agent tier, for the harness described below.

Reply with a single JSON object and nothing else — no prose, no code fence:
{"tier": "<tier name>", "confidence": <0.0-1.0>, "reason": "<one short sentence>"}

confidence is your own estimate that this tier is correct. Be honest: a low
number routes the task to a more senior tier, which is the cheaper mistake.

Choose the tier using the entry rules below. Classify by repo state and the
shape of the task, never by the language or framework the repo is written in.`;

export async function classify({
  task,
  buildGreen = null,
  files = [],
  manifest,
  duties,
  dir = agentDir(),
  call = callModel,
} = {}) {
  const tiers = manifest.agents?.length ? manifest.agents : Object.keys(LADDER);
  const fallback = pickFallback(manifest, tiers);

  // 1. A pinned entry tier skips the call entirely. Zero network traffic.
  if (manifest.entry && manifest.entry !== 'auto') {
    if (!tiers.includes(manifest.entry)) {
      throw new Error(
        `routing.entry is "${manifest.entry}", which is not in the agents list (${tiers.join(', ')}).\n` +
        '  Fix it in .gitagent/agent.yaml, or set it to auto.',
      );
    }
    return { tier: manifest.entry, confidence: 1, reason: 'routing.entry pins the tier', source: 'config' };
  }

  // 2. DUTIES.md entry rule 1 is deterministic: a red build routes to
  //    build-doctor and nothing else runs until it is green. No point paying
  //    for a model call to rediscover that. Unknown (null) is not red.
  if (buildGreen === false && tiers.includes('build-doctor')) {
    return { tier: 'build-doctor', confidence: 1, reason: 'the build is red; nothing else runs until it is green', source: 'repo-state' };
  }

  const rules = duties ?? readDuties(dir);
  const response = await call(manifest, {
    system: `${SYSTEM}\n\nAvailable tiers: ${tiers.join(', ')}\n\n--- DUTIES.md ---\n${rules}`,
    messages: [{ role: 'user', content: prompt(task, buildGreen, files) }],
    maxTokens: 256,
    temperature: 0,
  });

  const parsed = extractJson(response.text);
  const tier = typeof parsed?.tier === 'string' ? parsed.tier.trim() : null;

  // 3. A model that cannot return the shape does not get to pick the tier.
  //    That is what routing.degraded_fallback is for.
  if (!tier || !tiers.includes(tier)) {
    return {
      tier: fallback,
      confidence: 0,
      reason: tier
        ? `classifier returned unknown tier "${tier}"; using routing.degraded_fallback`
        : 'classifier did not return usable JSON; using routing.degraded_fallback',
      source: 'fallback',
    };
  }

  const confidence = clamp(parsed.confidence);
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
  const floor = manifest.confidenceFloor ?? 0.6;

  // 4. Below the floor, route one tier UP.
  if (confidence < floor) {
    const bumped = bump(tier, tiers, fallback);
    if (bumped !== tier) {
      return {
        tier: bumped,
        confidence,
        reason: `${reason || 'no reason given'} (confidence ${confidence} below floor ${floor}; routed up from ${tier})`,
        source: 'floor-bump',
        classified: tier,
      };
    }
  }

  return { tier, confidence, reason, source: 'model' };
}

function bump(tier, tiers, fallback) {
  // A persona the ladder does not know about routes to the terminal tier
  // rather than being guessed at.
  const next = LADDER[tier] ?? fallback;
  return tiers.includes(next) ? next : tier;
}

function pickFallback(manifest, tiers) {
  const declared = manifest.degradedFallback ?? 'senior-dev';
  if (tiers.includes(declared)) return declared;
  return tiers.includes('senior-dev') ? 'senior-dev' : tiers[tiers.length - 1];
}

function clamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function prompt(task, buildGreen, files) {
  const state = buildGreen === true ? 'green' : buildGreen === false ? 'red' : 'unknown (no verify command found)';
  const listed = files.slice(0, MAX_FILES);
  const more = files.length > listed.length ? `\n… and ${files.length - listed.length} more files` : '';
  return [
    `Task:\n${task}`,
    `\nBuild state: ${state}`,
    `\nRepository files:\n${listed.join('\n') || '(none listed)'}${more}`,
  ].join('\n');
}

function readDuties(dir) {
  const file = join(dir, 'DUTIES.md');
  if (!existsSync(file)) {
    throw new Error(`No DUTIES.md in ${dir}. It defines the entry rules the classifier routes by.`);
  }
  return readFileSync(file, 'utf8');
}
