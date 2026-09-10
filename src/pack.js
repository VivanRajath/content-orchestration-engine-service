import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, isAbsolute, normalize, sep } from 'node:path';
import { parseYaml } from './yaml.js';
import { loadHooks } from './hooks.js';

/**
 * Agent packs. A pack is a git repo that *is* the agent: personas, the handoff
 * contract, and guardrails, as reviewable Markdown and YAML. This module
 * fetches one, validates it, and reports what installing it would mean.
 *
 * The trust model is the whole reason this file is not four lines of clone and
 * copy. Installing a pack means running persona text written by whoever owns
 * that URL inside a tool with file-write and shell access. So:
 *
 *   - every path in the manifest is confined to the clone (no `../`, no
 *     absolute paths, no symlinks pointing out)
 *   - the pack cannot weaken a guardrail, only tighten one — enforced by
 *     hooks.js at load time; this module surfaces every attempt as a note
 *   - the resolved commit SHA is pinned into agent.yaml, so "pull from a URL"
 *     does not mean the persona changes under you between runs
 *
 * A pack ships no model, no key, and no api_key_env. Where someone's code gets
 * sent is not a pack author's decision to make.
 */

const MANIFEST = 'gitagent.yaml';
const REQUIRED_TIER_FILES = ['SOUL.md'];

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Shallow-clone a pack to a temp dir and resolve the exact commit.
 *
 * `--` before the url, and execFile semantics, so a url beginning with a dash
 * is an argument rather than a git flag. `ref` may be a branch, tag, or SHA;
 * a SHA needs a full clone because `--depth 1 --branch` does not take one.
 */
export function fetchPack(url, { ref = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jra-pack-'));
  const source = String(url);
  const looksLikeSha = ref && /^[0-9a-f]{7,40}$/i.test(ref);

  try {
    const args = looksLikeSha
      ? ['clone', '--quiet', '--', source, dir]
      : ['clone', '--depth', '1', '--quiet', ...(ref ? ['--branch', String(ref)] : []), '--', source, dir];
    run('git', args, { cwd: undefined });
    if (looksLikeSha) run('git', ['checkout', '--quiet', String(ref)], { cwd: dir });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `Could not clone ${source}${ref ? ` at ref "${ref}"` : ''}.\n` +
      `  ${firstLine(err.message)}`,
    );
  }

  let sha = null;
  try {
    sha = run('git', ['rev-parse', 'HEAD'], { cwd: dir }).trim();
  } catch {
    // A pack that cannot report its own commit is still installable; it just
    // cannot be pinned. readPack surfaces that so the caller can say so.
  }

  // The clone's own .git is not part of the agent and must not land in the
  // user's repo — a nested .git would silently break their working tree.
  rmSync(join(dir, '.git'), { recursive: true, force: true });

  return { dir, sha, url: source, ref: ref ?? null, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(cmd, args, opts) {
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

const firstLine = (s) => String(s).split('\n').find((l) => l.trim()) ?? '';

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/**
 * Parse and check gitagent.yaml. Throws on anything that would install a
 * broken or dishonest pack; collects the rest as notes for the caller to show.
 */
export function readPack(dir, { url = null, sha = null, ref = null } = {}) {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) {
    throw new Error(
      `No ${MANIFEST} in that repo — it is not an agent pack.\n` +
      '  A pack declares its tiers in gitagent.yaml at the repo root.\n' +
      '  To pull a single persona from an ordinary repo, use `personas add <name> --from <url>`.',
    );
  }

  const doc = parseYaml(readFileSync(file, 'utf8'), MANIFEST) ?? {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${MANIFEST}: expected a mapping at the top level`);
  }
  if (doc.kind && doc.kind !== 'AgentPack') {
    throw new Error(`${MANIFEST}: kind is "${doc.kind}", expected "AgentPack"`);
  }

  const notes = [];
  const meta = doc.metadata ?? {};

  // A pack naming a model or a key env var is the one thing that is refused
  // outright rather than warned about. It is not a mistake we can carry
  // forward safely: silently ignoring it leaves the user believing the pack
  // configured something it did not.
  const model = doc.model ?? {};
  const claimed = ['provider', 'name', 'api_key_env', 'base_url'].filter((k) => model[k] != null);
  if (claimed.length) {
    throw new Error(
      `${MANIFEST} declares model.${claimed.join(', model.')} — a pack may not choose your provider or key.\n` +
      '  Model config belongs in your own .gitagent/agent.yaml. Remove the model: block from the pack.',
    );
  }

  const agents = [];
  const declared = Array.isArray(doc.agents) ? doc.agents : [];
  if (!declared.length) throw new Error(`${MANIFEST}: no agents declared`);

  const seen = new Set();
  for (const entry of declared) {
    const tier = typeof entry === 'string' ? { name: entry } : entry;
    if (!tier || typeof tier !== 'object' || !tier.name) {
      throw new Error(`${MANIFEST}: every entry under agents: needs a name`);
    }
    const name = String(tier.name).trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      throw new Error(`${MANIFEST}: "${name}" is not a usable persona directory name`);
    }
    if (seen.has(name)) throw new Error(`${MANIFEST}: "${name}" is declared twice`);
    seen.add(name);

    const rel = confine(dir, tier.path ?? join('agents', name), `agents[${name}].path`);
    for (const f of REQUIRED_TIER_FILES) {
      if (!existsSync(join(dir, rel, f))) {
        throw new Error(`${MANIFEST}: "${name}" declares ${rel}/ but there is no ${f} there`);
      }
    }
    if (!existsSync(join(dir, rel, 'RULES.md'))) {
      notes.push(`${name}: no RULES.md — this tier ships identity but no constraints`);
    }
    agents.push({ name, tier: tier.tier ?? null, role: tier.role ?? '', path: rel });
  }

  const identity = {};
  for (const [key, fallback] of [['soul', 'SOUL.md'], ['rules', 'RULES.md'], ['duties', 'DUTIES.md']]) {
    const rel = confine(dir, (doc.identity ?? {})[key] ?? fallback, `identity.${key}`);
    if (existsSync(join(dir, rel))) identity[key] = rel;
    else if ((doc.identity ?? {})[key]) throw new Error(`${MANIFEST}: identity.${key} points at ${rel}, which is missing`);
    else notes.push(`no ${fallback} at the pack root`);
  }

  // DUTIES.md is the contract between tiers, not decoration. A pack with a
  // handoff graph and no written contract is the shape that installs a senior
  // escalating to a junior nobody pulled.
  if (!identity.duties && agents.length > 1) {
    notes.push('no DUTIES.md — the tiers have no written handoff contract');
  }

  const hooksRel = doc.hooks ? confine(dir, doc.hooks, 'hooks') : join('hooks', 'hooks.yaml');
  const hooks = existsSync(join(dir, hooksRel)) ? hooksRel : null;
  if (!hooks) notes.push('no hooks.yaml — the pack ships no guardrails of its own; the sealed ones still apply');

  // Every tier in the handoff graph must actually be installed.
  const missing = agents.filter((a) => a.path && !existsSync(join(dir, a.path)));
  if (missing.length) throw new Error(`${MANIFEST}: missing directories for ${missing.map((m) => m.name).join(', ')}`);

  return {
    dir,
    url,
    sha,
    ref,
    name: meta.name ? String(meta.name) : null,
    version: meta.version != null ? String(meta.version) : null,
    description: meta.description ? String(meta.description) : '',
    license: meta.license ? String(meta.license) : null,
    agents,
    identity,
    hooks,
    routing: doc.routing ?? {},
    notes,
    raw: doc,
  };
}

/**
 * Resolve a manifest-declared path inside the clone, or refuse it.
 *
 * A pack author controls this string. `../../.ssh`, `/etc/passwd`, and a
 * symlink pointing out of the clone all have to fail here, because everything
 * downstream is a copy into the user's repo.
 */
export function confine(root, rawPath, label) {
  const raw = String(rawPath ?? '').trim();
  if (!raw) throw new Error(`${MANIFEST}: ${label} is empty`);
  if (isAbsolute(raw) || /^[a-z]:/i.test(raw)) {
    throw new Error(`${MANIFEST}: ${label} is an absolute path ("${raw}"). Pack paths are repo-relative.`);
  }

  const rel = normalize(raw).replace(/[\\/]+$/, '');
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.split(/[\\/]/).includes('..')) {
    throw new Error(`${MANIFEST}: ${label} escapes the pack ("${raw}")`);
  }

  // normalize() collapses `a/../b`, so the string check above is not enough on
  // its own once symlinks are in play: check what the path actually resolves to.
  const full = join(root, rel);
  if (existsSync(full)) {
    if (isSymlink(full)) throw new Error(`${MANIFEST}: ${label} ("${raw}") is a symlink; pack paths must be real files`);
  }
  return rel;
}

/** True when the path itself is a symlink. lstat, not stat: stat follows it. */
function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * What installing this pack would mean, in the terms that matter: which tiers
 * arrive, which guardrails they bring, and every attempt the pack made to
 * loosen a sealed one.
 *
 * The sealing itself lives in hooks.js and happens at load time regardless —
 * loading the pack's hooks here is how we find out what it *tried* to do, so
 * the user sees it before the files land rather than never.
 */
export function inspectHooks(pack) {
  const out = { phases: {}, notes: [] };
  if (!pack.hooks) return out;
  try {
    const set = loadHooks(pack.dir, { reload: true });
    for (const phase of ['pre_edit', 'pre_command', 'pre_commit', 'post_run']) {
      const names = Object.values(set[phase])
        .filter((h) => h.enabled !== false)
        .map((h) => h.name);
      if (names.length) out.phases[phase] = names;
    }
    out.notes = set.notes ?? [];
  } catch (err) {
    // Fail closed, same as a run would. A pack whose guardrail file does not
    // parse must not install into a repo where it would then abort every run.
    throw new Error(`${pack.hooks} in that pack does not parse:\n  ${firstLine(err.message)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Copy the pack into `dest` (.gitagent/). The pack's own manifest is copied in
 * too: it records where the agent came from, and `personas` reads it to know
 * which tiers were installed as a set.
 *
 * Symlinks are dereferenced rather than copied. A symlink in a pack that
 * resolves to something outside it is a file the user did not agree to install.
 */
export function installPack(pack, dest) {
  cpSync(pack.dir, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const parts = src.split(/[\\/]/);
      return !parts.includes('.git') && !SKIP.has(parts[parts.length - 1]);
    },
  });
}

/**
 * The pack repo's own housekeeping, which is not part of the agent. Its
 * .gitignore governs the pack repo, not the repo it is being installed into —
 * copying it in would silently add rules to a project that never asked for
 * them, and init writes the ignore rules that actually matter itself.
 */
const SKIP = new Set(['.gitignore', '.gitattributes', '.github', '.DS_Store']);
