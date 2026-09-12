import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './paths.js';
import { parseYaml } from './yaml.js';
import { globToRegExp, normalizePath } from './hooks.js';

/**
 * The installed agents, read from the agents themselves.
 *
 * build-doctor, junior-dev, senior-dev and ui-editor are a DEFAULT PACK, not
 * the product. A user adds whatever agents they want from wherever they want,
 * so nothing here may assume a fixed set, a fixed count, or a fixed ladder —
 * an agent describes its own priority, scope and appetite for parallelism in
 * its own SOUL.md front matter, and this module only reads it back.
 *
 * That is also why there is no global SOUL.md or RULES.md any more. Identity
 * injected by the harness into every agent makes the harness the author of
 * agents it did not write, and a pulled agent's own file stops being the thing
 * that defines it.
 *
 *   ---
 *   name: reviewer
 *   role: Reviews diffs before they land
 *   priority: 2                  lower numbers claim work first
 *   owns: ["**\/*.test.js"]       glob scope; omitted means "anything"
 *   parallel: true               may run alongside other agents
 *   escalates_to: senior-dev     who takes over when it runs out of attempts
 *   terminal: true               instead: stop and ask the human
 *   fixes_build: true            a red build routes here before anything else
 *   attempts: 2                  tries before it escalates
 *   model: gpt-4o-mini           optional, overrides agent.yaml for this agent
 *   ---
 */

const DEFAULTS = { priority: 50, parallel: false, owns: [], model: null };

/**
 * Who an agent hands to when it is out of attempts.
 *
 * Declared by the agent (`escalates_to`), not by the harness. The old version
 * of this was a lookup table of the four names this scaffold happens to ship,
 * which meant a user's own agent could never be escalated to — it was not in
 * the table. An agent that declares `terminal: true` escalates to the human.
 *
 * With neither declared the next agent by priority takes it, which is the
 * behaviour someone gets for free by ordering their agents sensibly.
 */
export function escalatesTo(agent, agents) {
  if (agent.terminal) return null;
  if (agent.escalatesTo) {
    const named = agents.find((a) => a.name === agent.escalatesTo);
    // A named successor that is not installed is a dead end, not a silent
    // fallthrough to somebody else's agent.
    return named && named.name !== agent.name ? named.name : null;
  }
  const after = agents.filter((a) => a.priority > agent.priority);
  return after.length ? after[0].name : null;
}

/** Split `---` front matter off a Markdown file. Returns {meta, body}. */
export function frontMatter(text, source = 'SOUL.md') {
  const s = String(text ?? '');
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: s };
  let meta = {};
  try {
    const parsed = parseYaml(m[1], source);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
  } catch {
    // A malformed header costs the agent its metadata, not its existence. It
    // still runs, at default priority, owning nothing in particular.
  }
  return { meta, body: s.slice(m[0].length) };
}

/**
 * Every agent in `.gitagent/agents/`, in the order they should claim work.
 *
 * Directory presence is what installs an agent — not a list in agent.yaml.
 * `jr-arch add-agent` drops a folder in and the agent exists; deleting the
 * folder removes it. A manifest list that has to agree with the filesystem is
 * a second source of truth, and the two drift.
 */
export function readAgents(dir = agentDir()) {
  const base = join(dir, 'agents');
  if (!existsSync(base)) return [];

  const found = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const soul = join(base, entry.name, 'SOUL.md');
    if (!existsSync(soul)) continue;

    const { meta } = frontMatter(readFileSync(soul, 'utf8'), `agents/${entry.name}/SOUL.md`);
    found.push({
      name: entry.name,
      dir: join(base, entry.name),
      role: str(meta.role),
      priority: num(meta.priority, DEFAULTS.priority),
      parallel: meta.parallel === true,
      owns: list(meta.owns),
      model: str(meta.model) || null,
      escalatesTo: str(meta.escalates_to) || null,
      terminal: meta.terminal === true,
      // Declared, not inferred from a name. DUTIES entry rule 1 routes a red
      // build here, and "the agent called build-doctor" only works for repos
      // that happen to use the default pack's names.
      fixesBuild: meta.fixes_build === true,
      attempts: num(meta.attempts, null),
      provider: str(meta.provider) || null,
      keyEnv: str(meta.api_key_env) || null,
      hasRules: existsSync(join(base, entry.name, 'RULES.md')),
    });
  }

  // Priority first, then name, so the order is stable across machines —
  // readdir order is not, and an unstable order makes a swarm unreproducible.
  return found.sort((a, b) => a.priority - b.priority || (a.name < b.name ? -1 : 1));
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);

export function findAgent(name, agents) {
  return agents.find((a) => a.name === name) ?? null;
}

/** The agent a red build routes to, if any is installed that claims to fix them. */
export function buildFixer(agents) {
  return agents.find((a) => a.fixesBuild) ?? null;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Does this agent own this path?
 *
 * An agent with no `owns` owns anything — the common case, and the one a
 * single-agent setup needs. Scope here is about who CLAIMS work, not about
 * what is permitted: permission is hooks.js, which is enforced whether or not
 * an agent agrees with it.
 */
export function ownsPath(agent, path) {
  if (!agent.owns.length) return true;
  const rel = normalizePath(path);
  return agent.owns.some((glob) => globToRegExp(glob).test(rel));
}

/**
 * Divide paths between agents, highest priority first.
 *
 * A path goes to exactly one agent: the first, by priority, that claims it.
 * Overlapping scopes are normal — two agents both matching `src/**` is how a
 * user says "this one first, that one for the rest" — and letting both write
 * the same file in parallel is how a swarm corrupts its own output.
 */
export function partition(agents, paths) {
  const claims = new Map(agents.map((a) => [a.name, []]));
  const unclaimed = [];

  for (const path of paths) {
    const owner = agents.find((a) => ownsPath(a, path));
    if (owner) claims.get(owner.name).push(path);
    else unclaimed.push(path);
  }
  return { claims, unclaimed };
}

/**
 * The agents that may run at the same time.
 *
 * Two agents can run together only when both opted in AND their scopes are
 * disjoint. Scope is what makes parallelism safe here: agents write into one
 * working tree, so two agents owning the same glob would race on the same file.
 * An agent that declares no scope owns everything, and therefore overlaps with
 * everyone — it runs alone.
 */
export function swarmable(agents) {
  const groups = [];
  for (const agent of agents) {
    if (!agent.parallel || !agent.owns.length) { groups.push([agent]); continue; }
    const group = groups.find((g) =>
      g.every((other) => other.parallel && other.owns.length && disjoint(other, agent)));
    if (group) group.push(agent);
    else groups.push([agent]);
  }
  return groups;
}

/**
 * Do two agents' scopes provably not overlap?
 *
 * Glob intersection is undecidable in general, so this is deliberately
 * conservative: it compares the literal prefix before the first wildcard, and
 * anything it cannot prove disjoint is treated as overlapping. Being wrong
 * here means running two agents sequentially that could have been parallel,
 * which costs time. The other direction costs the user's files.
 */
export function disjoint(a, b) {
  for (const x of a.owns) {
    for (const y of b.owns) {
      if (x === y) return false;
      const px = prefix(x);
      const py = prefix(y);
      if (px.startsWith(py) || py.startsWith(px)) return false;
    }
  }
  return true;
}

const prefix = (glob) => {
  const i = String(glob).search(/[*?[]/);
  const head = i === -1 ? String(glob) : String(glob).slice(0, i);
  return head.slice(0, head.lastIndexOf('/') + 1);
};
