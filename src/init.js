import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { TEMPLATES, agentDir, repoRoot } from './paths.js';
import { patchSection, upsertSection } from './config.js';
import { readAgents } from './agents.js';
import { fetchPack, readPack, inspectHooks, installPack, writeLock } from './pack.js';
import { PROVIDERS, providerFor } from './providers.js';
import { c, ok, info, warn } from './util.js';

// Defaults for `init --provider X` without --model. Onboarding does not use
// these: it lists the models the key can actually reach and lets you pick.
const DEFAULT_MODEL = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  groq: 'llama-3.3-70b-versatile',
  ollama: 'qwen2.5-coder:14b',
};

// Just the manifest and the contract; agents come from add-agent.
const MINIMAL = ['agent.yaml', 'DUTIES.md'];

export async function init(flags) {
  const root = repoRoot();
  const dir = agentDir();

  if (existsSync(dir) && !flags.force) {
    throw new Error(`.gitagent/ already exists at ${dir}\n  Use --force to overwrite, or edit the files directly.`);
  }

  const provider = flags.provider || 'anthropic';
  const spec = providerFor(provider);
  if (!spec) {
    throw new Error(`Unknown provider "${provider}". One of: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  const p = { key: spec.keyEnv };
  const model = flags.model || DEFAULT_MODEL[provider] || null;
  // Only an explicit --base-url is written to the manifest. A provider's own
  // endpoint is resolved at request time, so it is not frozen into the file.
  const baseUrl = flags['base-url'] || (provider === 'ollama' ? spec.base : null);

  if (!model) throw new Error(`Provider "${provider}" has no default model. Pass --model.`);
  if (provider === 'openai-compatible' && !baseUrl) {
    throw new Error('Provider "openai-compatible" requires --base-url.');
  }

  // A pack is fetched and validated BEFORE anything is written. Half an agent
  // in .gitagent/ because a clone failed at file nine is worse than no agent:
  // the next run reads it and behaves unpredictably rather than failing.
  let pack = null;
  if (flags.from) {
    if (flags.minimal) throw new Error('--minimal scaffolds the bundled templates; it does not apply to --from.');
    pack = loadPack(flags);
  }

  mkdirSync(dir, { recursive: true });

  try {
    if (pack) {
      installPack(pack, dir);
      // Record what landed and at which commit. `pull` diffs against this to
      // tell a persona you edited from one the pack changed.
      writeLock(dir, pack);
      cpSync(join(TEMPLATES, 'agent.yaml'), join(dir, 'agent.yaml'));
      for (const sub of ['config', 'memory']) {
        const src = join(TEMPLATES, sub);
        if (!existsSync(join(dir, sub)) && existsSync(src)) cpSync(src, join(dir, sub), { recursive: true });
      }
    } else if (flags.minimal) {
      for (const f of MINIMAL) cpSync(join(TEMPLATES, f), join(dir, f));
    } else {
      cpSync(TEMPLATES, dir, { recursive: true });
    }
  } finally {
    pack?.cleanup?.();
  }

  // Patch agent.yaml. patchSection scopes each edit to the model: block —
  // `name:` also appears under metadata:, and a file-wide replace clobbers it.
  const manifestPath = join(dir, 'agent.yaml');
  let manifest = readFileSync(manifestPath, 'utf8');
  for (const [key, value] of [
    ['provider',    provider],
    ['name',        model],
    ['api_key_env', p.key],
    ['base_url',    baseUrl ?? 'null'],
  ]) {
    manifest = patchSection(manifest, 'model', key, value);
  }
  if (pack) {
    // The pack decides which tiers exist and how they hand off; the user's
    // manifest has to agree, or the classifier routes to a tier that is not
    // installed. routing values are the pack's suggestion, not a lock — every
    // one of them stays editable in the user's own file afterwards.
    // No agents list to write: the pack's agents/ directory landed above, and
    // the directory is what installs them.
    for (const [key, value] of Object.entries(pack.routing ?? {})) {
      try { manifest = patchSection(manifest, 'routing', key, value); }
      catch { /* a routing key we do not ship is the pack's, not ours to add */ }
    }
    manifest = upsertSection(manifest, 'source', sourceBlock(pack));
  }

  writeFileSync(manifestPath, manifest);

  // Never let a key land in git.
  const gitignore = join(root, '.gitignore');
  const rules = ['.gitagent/.env', '.gitagent/.session/'];
  const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const missing = rules.filter((r) => !current.includes(r));
  if (missing.length) {
    appendFileSync(gitignore, `${current && !current.endsWith('\n') ? '\n' : ''}\n# jr-arch\n${missing.join('\n')}\n`);
  }

  // Onboarding scaffolds through here too, and draws its own tree and next
  // steps afterwards; printing both would say everything twice.
  if (flags.quiet) return { root, dir, provider, model, keyEnv: p.key };

    ok(`Scaffolded ${c.c('.gitagent/')} in ${root}`);
    console.log();
    info(`provider   ${provider}`);
    info(`model      ${model}`);
    if (baseUrl) info(`base_url   ${baseUrl}`);
    info(`api key    read from $${p.key}`);
    console.log();

    if (pack) {
      info(`pack       ${pack.name ?? pack.url}${pack.version ? ` v${pack.version}` : ''}`);
      info(`source     ${pack.url}${pack.sha ? ` @ ${pack.sha.slice(0, 7)}` : ''}`);
      info(`agents     ${pack.agents.map((a) => a.name).join(', ')}`);
      info(`guardrails ${pack.hooks ? '.gitagent/' + pack.hooks.split(sep).join('/') : 'sealed hooks only'}`);
    } else if (!flags.minimal) {
      info(`agents     ${readAgents(dir).map((a) => a.name).join(', ')}`);
      info('guardrails .gitagent/hooks/');
    }
    console.log();

    if (!pack?.sha && pack) {
      warn('This pack could not report a commit — it is installed but not pinned.');
    }

    if (!process.env[p.key]) {
      warn(`$${p.key} is not set.`);
      info(`store one:  ${c.c('jr-arch key <your-key>')}`);
    }

    console.log(c.b('Next:'));
    if (pack) info('review .gitagent/agents/*/RULES.md — a pulled pack is untrusted input');
    info('edit .gitagent/agents/*/RULES.md to shape each agent');
    info('add  jr-arch add-agent <git-url>   to install another');
    info('edit .gitagent/hooks/hooks.yaml to set guardrails');
    info('run  jr-arch doctor   to verify your model can drive the tiers');

  return { root, dir, provider, model, keyEnv: p.key };
}


/**
 * Fetch, validate, and report a pack before a single file is written.
 *
 * The report is not decoration. Installing a pack means running persona text
 * written by whoever owns that URL, in a tool that edits files and runs
 * commands — so what arrives, and every attempt it made to loosen a sealed
 * guardrail, is shown before the copy rather than discovered afterwards.
 */
function loadPack(flags) {
  const ref = typeof flags.ref === 'string' ? flags.ref : null;
  const fetched = fetchPack(flags.from, { ref });
  let pack;
  try {
    pack = readPack(fetched.dir, { url: fetched.url, sha: fetched.sha, ref });
    pack.cleanup = fetched.cleanup;
    const hooks = inspectHooks(pack);

    console.log();
    ok(`Pack ${c.c(pack.name ?? pack.url)}${pack.version ? ` v${pack.version}` : ''}`);
    if (pack.description) info(pack.description);
    console.log();
    for (const a of pack.agents) info(`${c.c(a.name.padEnd(14))}${a.role}`);
    for (const [phase, names] of Object.entries(hooks.phases)) {
      info(`${phase.padEnd(14)}${names.join(', ')}`);
    }
    // A pack cannot weaken a sealed hook — hooks.js drops the attempt at load
    // time either way. It can still be the reason not to install this pack.
    for (const note of [...hooks.notes, ...pack.notes]) warn(note);
    console.log();
  } catch (err) {
    fetched.cleanup();
    throw err;
  }
  return pack;
}

/** Where this agent came from, pinned. Written into the user's agent.yaml. */
function sourceBlock(pack) {
  return [
    '# Where this agent came from. `jr-arch pull` re-reads it.',
    `url: ${pack.url}`,
    `ref: ${pack.ref ?? 'null'}`,
    `commit: ${pack.sha ?? 'null'}`,
    `pack: ${pack.name ?? 'null'}`,
    `version: ${pack.version ?? 'null'}`,
  ].join('\n');
}
