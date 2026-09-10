import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { agentDir } from './paths.js';
import { readManifest, patchSection, patchSequence, upsertSection } from './config.js';
import { fetchPack, readPack, inspectHooks, planUpdate, readLock, writeLock } from './pack.js';
import { c, ok, info, warn } from './util.js';

/**
 * Update an installed pack to a newer commit.
 *
 * `.gitagent/` is meant to be edited — that is the entire pitch, and a persona
 * you have tuned to your team is the most valuable thing in the directory. So
 * this is a merge, not a re-install: the lock written at install time is what
 * lets it tell "you changed this" from "the pack changed this", and a file in
 * the first category is never overwritten without --force.
 */
export async function pull(positional, flags) {
  const dir = agentDir();
  if (!existsSync(join(dir, 'agent.yaml'))) {
    throw new Error('No .gitagent/ found. Run `jr-architect init --from <git-url>` first.');
  }

  const manifest = readManifest();
  const source = manifest.source ?? {};
  const url = positional?.[0] ?? flags.from ?? source.url;
  if (!url) {
    throw new Error(
      'This .gitagent/ did not come from a pack, so there is nothing to pull.\n' +
      '  Point it at one:  jr-architect pull <git-url>',
    );
  }

  // An explicit --ref wins; otherwise follow the branch this was installed
  // from. Deliberately NOT the pinned commit: pinning records what you have,
  // it does not mean pull can never move you forward.
  const ref = typeof flags.ref === 'string' ? flags.ref : source.ref ?? null;
  const lock = readLock(dir);

  if (!lock) {
    warn('No .pack.lock — cannot tell your edits from the pack\'s.');
    info('Every file the pack ships will be treated as a possible local edit.');
    console.log();
  }

  const fetched = fetchPack(url, { ref });
  try {
    const next = readPack(fetched.dir, { url: fetched.url, sha: fetched.sha, ref });

    if (lock?.commit && next.sha && lock.commit === next.sha && !flags.force) {
      ok(`Already at ${c.c(next.sha.slice(0, 7))} — ${next.name ?? url} is up to date.`);
      return;
    }

    const plan = planUpdate(dir, next, lock);
    const moves = plan.create.length + plan.update.length + plan.remove.length;

    report(next, lock, plan, flags);

    if (flags['dry-run']) {
      info('Dry run — nothing was written.');
      return;
    }
    if (!moves && !(flags.force && plan.conflict.length)) {
      ok('Nothing to apply.');
      if (plan.conflict.length) info('Only locally-edited files differ. Use --force to overwrite them.');
      return;
    }

    apply(dir, next, plan, flags);
    rewriteManifest(dir, next);
    // The lock records what the PACK ships, not what is on disk, so a file
    // kept back by a conflict still compares correctly on the next pull.
    writeLock(dir, next);

    console.log();
    ok(`Updated to ${c.c(next.sha ? next.sha.slice(0, 7) : 'HEAD')}${next.version ? ` (v${next.version})` : ''}`);
    if (plan.conflict.length && !flags.force) {
      warn(`${plan.conflict.length} locally-edited file(s) kept as they are.`);
      info('Re-run with --force to take the pack\'s version instead.');
    }
  } finally {
    fetched.cleanup();
  }
}

function report(next, lock, plan, flags) {
  console.log();
  const from = lock?.commit ? lock.commit.slice(0, 7) : 'unknown';
  const to = next.sha ? next.sha.slice(0, 7) : 'HEAD';
  ok(`${c.c(next.name ?? next.url)}  ${from} → ${to}`);
  console.log();

  const hooks = inspectHooks(next);
  for (const note of [...hooks.notes, ...next.notes]) warn(note);
  if (hooks.notes.length || next.notes.length) console.log();

  for (const [label, list, colour] of [
    ['new     ', plan.create, c.g],
    ['updated ', plan.update, c.c],
    ['removed ', plan.remove, c.y],
  ]) {
    for (const rel of list) info(`${colour(label)}${rel}`);
  }

  for (const rel of plan.conflict) {
    info(`${flags.force ? c.r('OVERWRITE') : c.y('yours   ')}${flags.force ? ' ' : ''}${rel}`);
  }
  for (const rel of plan.orphaned) {
    info(`${c.y('orphaned')}${rel} — dropped by the pack, kept because you edited it`);
  }
  if (plan.unchanged.length) info(c.d(`${plan.unchanged.length} file(s) already current`));
  console.log();
}

function apply(dir, next, plan, flags) {
  const write = [...plan.create, ...plan.update, ...(flags.force ? plan.conflict : [])];
  for (const rel of write) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(next.dir, rel), target, { dereference: true });
  }
  for (const rel of plan.remove) rmSync(join(dir, rel), { force: true });
}

/**
 * Re-apply the pack's tier list and routing to the user's agent.yaml.
 *
 * The model block is never touched — provider, key env var, and base url are
 * the user's, and an update that quietly re-pointed them at a different model
 * would be the exact failure the pack rules are written to prevent.
 */
function rewriteManifest(dir, next) {
  const file = join(dir, 'agent.yaml');
  let text = readFileSync(file, 'utf8');

  text = patchSequence(text, 'agents', next.agents.map((a) => a.name));
  for (const [key, value] of Object.entries(next.routing ?? {})) {
    // Only keys already present are updated. A routing key the user deleted
    // was deleted on purpose, and one we do not ship is the pack's invention.
    try { text = patchSection(text, 'routing', key, value); } catch { /* leave it */ }
  }
  text = upsertSection(text, 'source', [
    '# Where this agent came from. `jr-architect pull` re-reads it.',
    `url: ${next.url}`,
    `ref: ${next.ref ?? 'null'}`,
    `commit: ${next.sha ?? 'null'}`,
    `pack: ${next.name ?? 'null'}`,
    `version: ${next.version ?? 'null'}`,
  ].join('\n'));

  writeFileSync(file, text);
}
