import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir, repoRoot } from './paths.js';
import { readManifest, upsertSection } from './config.js';
import { readAgents } from './agents.js';
import { inspect } from './detect.js';
import { callModel, extractJson } from './provider.js';
import { writeKey, ensureIgnored } from './env.js';
import { obtainKey, pickModel } from './onboard.js';
import { listModels } from './providers.js';
import { printTree } from './tree.js';
import { c, ok, info, warn } from './util.js';

/**
 * /prompt — describe what you need, and the agents are written for you.
 *
 * The model PROPOSES; the harness WRITES. The model returns a plan as data,
 * every field of it is validated, and the files are built from the validated
 * values. Nothing the model produces is written to disk verbatim except the
 * prose bodies of SOUL.md and RULES.md.
 *
 * That boundary is the point. Front matter written by a model could quietly
 * declare `fixes_build` on three agents, or an escalation loop that never ends.
 * Guard YAML written by a model could try to switch a guardrail off. Building
 * both from checked values means the worst a bad generation can do is produce
 * a plan you decline at the preview.
 */

const MAX_AGENTS = 8;
const NAME = /^[a-z][a-z0-9-]{1,31}$/;
const RESERVED = new Set(['hooks', 'config', 'memory', 'agents', 'session']);

// ---------------------------------------------------------------------------
// The interview
// ---------------------------------------------------------------------------

export async function interview(prompter, { root = repoRoot() } = {}) {
  console.log();
  console.log(`  ${c.b('/prompt')}  ${c.d('describe what your agents are for — they are written from your answers')}`);
  console.log();

  const goal = await prompter.ask('What should your coding agents do?\n  ›');
  if (!goal) return null;

  const found = inspect(root);
  const stack = [
    ...found.stacks.map((s) => s.name),
    ...found.frameworks,
    found.monorepo ? `monorepo (${found.monorepo.kind})` : '',
  ].filter(Boolean).join(', ');
  const project = await prompter.ask('What kind of project is this?', { default: stack || '' });

  const critical = await prompter.ask(
    'Which files or folders must agents never change? (comma-separated, blank for none)\n  ›',
  );

  const verify = await prompter.ask(
    'How should agents check their work?',
    { default: found.verify?.label ?? '' },
  );

  const approval = await prompter.ask(
    'Anything that must always wait for your approval? (blank for the defaults)\n  ›',
  );

  const shape = await prompter.choose('How many agents?', [
    { value: 'auto', label: 'Decide for me', note: 'based on what you described' },
    { value: 'one', label: 'One agent', note: 'simplest, cheapest' },
    { value: 'team', label: 'A team', note: 'split by responsibility, can run in parallel' },
  ]);

  return {
    goal,
    project: project || stack || 'unknown',
    critical: splitList(critical),
    verify: verify || null,
    approval: approval || '',
    shape: shape ?? 'auto',
    files: found,
  };
}

const splitList = (s) => String(s ?? '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export const PLAN_SYSTEM = `You design coding agents for a harness called jr-arch. You do not write code.
You write the agents that will.

Reply with ONE JSON object and nothing else — no prose, no code fence.

{
  "agents": [
    {
      "name": "lowercase-with-dashes",
      "role": "one line: what this agent is responsible for",
      "priority": 0-100,              // lower claims work first
      "owns": ["glob", ...],          // files this agent claims; [] means anything
      "parallel": true | false,       // only true if owns is non-empty and disjoint from others
      "escalates_to": "agent-name" | null,
      "terminal": true | false,       // true: stops and asks the human instead of escalating
      "fixes_build": true | false,    // at most ONE agent: the one a red build goes to
      "attempts": 1-5,
      "soul": "markdown: who this agent is, how it works, its voice, when it hands off",
      "rules": "markdown with exactly these headings: ## Must, ## Must not, ## Hand off when"
    }
  ],
  "guards": {
    "protected_paths": ["glob", ...],   // files no agent may edit
    "checkpoint_paths": ["glob", ...]   // edits that must wait for human approval
  }
}

Rules for the design:
- Split agents by RESPONSIBILITY, never by programming language.
- Every escalates_to must name another agent in your list.
- No escalation cycles. Exactly one agent at the top should be terminal.
- Be specific in soul and rules: name real files, folders and commands from the
  project description. Generic advice ("write clean code") is worthless here.
- Keep each soul under 250 words and each rules under 200 words.`;

export function planPrompt(answers) {
  const f = answers.files ?? {};
  const shape = { one: 'Exactly ONE agent.', team: 'A team of 2 to 6 agents.', auto: 'Choose the number of agents the work needs, from 1 to 6.' }[answers.shape];
  return [
    `## What the agents are for\n${answers.goal}`,
    `\n## The project\n${answers.project}`,
    f.stacks?.length ? `\nDetected: ${f.stacks.map((s) => `${s.name} (${s.manifest}${s.lock ? `, ${s.lock}` : ', no lockfile'})`).join('; ')}` : '',
    f.monorepo ? `\nMonorepo: ${f.monorepo.kind} ${f.monorepo.globs?.join(', ') ?? ''}` : '',
    `\n## How work is verified\n${answers.verify ?? 'no verify command found'}`,
    `\n## Must never be changed\n${answers.critical.length ? answers.critical.join('\n') : 'nothing specified beyond the defaults'}`,
    `\n## Always needs human approval\n${answers.approval || 'dependency changes, schema migrations, auth and crypto'}`,
    `\n## Shape\n${shape}`,
  ].filter(Boolean).join('\n');
}

/**
 * Ask for a plan, and ask once more if it comes back unusable.
 *
 * The retry carries the specific validation errors. A model told "field
 * escalates_to names 'reviewer', which is not in your list" fixes that; a
 * model told "try again" usually produces the same mistake.
 */
export async function generatePlan(answers, manifest, { call = callModel, onProgress = () => {} } = {}) {
  const messages = [{ role: 'user', content: planPrompt(answers) }];

  for (let round = 0; round < 2; round++) {
    onProgress(round === 0 ? 'designing agents' : 'fixing the plan');
    const reply = await call(manifest, { system: PLAN_SYSTEM, messages, maxTokens: 6000, temperature: 0.3 });
    const parsed = extractJson(reply.text);
    const { plan, errors } = validatePlan(parsed, answers);
    if (plan) return { plan, errors: [], rounds: round + 1 };

    if (round === 0) {
      messages.push({ role: 'assistant', text: reply.text });
      messages.push({
        role: 'user',
        content: `That plan cannot be used:\n${errors.map((e) => `- ${e}`).join('\n')}\n\nReply with the corrected JSON object only.`,
      });
    } else {
      return { plan: null, errors, rounds: 2 };
    }
  }
  return { plan: null, errors: ['no plan produced'], rounds: 2 };
}

// ---------------------------------------------------------------------------
// Validation — the trust boundary
// ---------------------------------------------------------------------------

/**
 * Turn whatever came back into a plan the harness is willing to write, or a
 * list of reasons it is not.
 *
 * Hard errors reject the plan. Things that can be made safe without changing
 * what the user asked for are fixed and recorded as notes — a `parallel: true`
 * on an agent with no scope is quietly downgraded, because two unscoped agents
 * running at once would race on the same files.
 */
export function validatePlan(raw, answers = {}) {
  const errors = [];
  const notes = [];

  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.agents)) {
    return { plan: null, errors: ['the reply was not a JSON object with an "agents" array'] };
  }
  if (!raw.agents.length) return { plan: null, errors: ['"agents" is empty'] };
  if (raw.agents.length > MAX_AGENTS) errors.push(`${raw.agents.length} agents is too many — at most ${MAX_AGENTS}`);

  const agents = [];
  const seen = new Set();

  raw.agents.forEach((a, i) => {
    const where = `agent ${i + 1}`;
    if (!a || typeof a !== 'object') { errors.push(`${where} is not an object`); return; }

    const name = String(a.name ?? '').trim().toLowerCase();
    if (!NAME.test(name)) { errors.push(`${where}: name "${a.name}" must be lowercase letters, digits and dashes, 2–32 long`); return; }
    if (RESERVED.has(name)) { errors.push(`${where}: "${name}" is a reserved folder name`); return; }
    if (seen.has(name)) { errors.push(`${where}: "${name}" is used twice`); return; }
    seen.add(name);

    const soul = text(a.soul, 6000);
    const rules = text(a.rules, 4000);
    if (!soul) errors.push(`${name}: soul is empty`);
    if (!rules) errors.push(`${name}: rules is empty`);

    const owns = globs(a.owns, name, errors);
    let parallel = a.parallel === true;
    if (parallel && !owns.length) {
      parallel = false;
      notes.push(`${name}: parallel turned off — an agent with no scope overlaps with every other agent`);
    }

    agents.push({
      name,
      role: line(a.role, 120) || 'no role given',
      priority: clampInt(a.priority, 0, 100, 50),
      owns,
      parallel,
      escalatesTo: a.escalates_to ? String(a.escalates_to).trim().toLowerCase() : null,
      terminal: a.terminal === true,
      fixesBuild: a.fixes_build === true,
      attempts: clampInt(a.attempts, 1, 5, 2),
      soul,
      rules,
    });
  });

  const names = new Set(agents.map((a) => a.name));
  for (const a of agents) {
    if (a.escalatesTo === a.name) { a.escalatesTo = null; notes.push(`${a.name}: escalated to itself — removed`); }
    if (a.escalatesTo && !names.has(a.escalatesTo)) {
      errors.push(`${a.name}: escalates_to names "${a.escalatesTo}", which is not in your list`);
    }
    if (a.terminal && a.escalatesTo) {
      a.escalatesTo = null;
      notes.push(`${a.name}: terminal and escalating at once — kept terminal`);
    }
  }

  // More than one build fixer makes "where does a red build go" ambiguous.
  const fixers = agents.filter((a) => a.fixesBuild);
  if (fixers.length > 1) {
    for (const f of fixers.slice(1)) f.fixesBuild = false;
    notes.push(`fixes_build kept only on ${fixers[0].name} — a red build has to go to exactly one agent`);
  }

  // An escalation cycle would pass a task round in a loop until every agent in
  // it had spent its attempts, forever. Break it at the most senior member.
  const cycle = findCycle(agents);
  if (cycle) {
    const top = cycle.map((n) => agents.find((a) => a.name === n)).sort((x, y) => y.priority - x.priority)[0];
    top.escalatesTo = null;
    top.terminal = true;
    notes.push(`escalation loop ${cycle.join(' → ')} → ${cycle[0]} broken: ${top.name} is now terminal`);
  }

  if (!agents.some((a) => a.terminal)) {
    const last = [...agents].sort((a, b) => b.priority - a.priority)[0];
    if (last && !last.escalatesTo) {
      last.terminal = true;
      notes.push(`${last.name} made terminal — something has to stop and ask you`);
    }
  }

  const guards = {
    protectedPaths: [
      ...globs(raw.guards?.protected_paths, 'guards.protected_paths', errors),
      ...(answers.critical ?? []).filter((p) => safeGlob(p)),
    ].filter((v, i, arr) => arr.indexOf(v) === i),
    checkpointPaths: globs(raw.guards?.checkpoint_paths, 'guards.checkpoint_paths', errors),
  };

  if (errors.length) return { plan: null, errors };
  return { plan: { agents, guards, notes }, errors: [] };
}

function findCycle(agents) {
  const next = new Map(agents.map((a) => [a.name, a.escalatesTo]));
  for (const start of next.keys()) {
    const path = [];
    let at = start;
    while (at && !path.includes(at)) {
      path.push(at);
      at = next.get(at);
    }
    if (at) return path.slice(path.indexOf(at));
  }
  return null;
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * A field that must stay on one line, because it is written into front matter.
 *
 * A newline in `role` used to be written straight into a quoted scalar that
 * then spanned several lines. The strict parser rejects that, `frontMatter`
 * returns no metadata at all, and the agent silently runs with defaults — no
 * scope, not terminal, default priority. It would claim every file and never
 * stop to ask. A model does not have to be hostile to cause it; wrapping a long
 * role is enough.
 */
const line = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** A glob the harness is willing to write into a file an agent reads. */
function safeGlob(g) {
  const s = String(g ?? '').trim();
  return s && s.length <= 200 && !/^[\\/]|^[a-z]:|(^|[\\/])\.\.([\\/]|$)|[\r\n"]/i.test(s);
}

function globs(v, where, errors) {
  if (v == null) return [];
  if (!Array.isArray(v)) { errors.push(`${where}: expected a list of globs`); return []; }
  const out = [];
  for (const g of v) {
    if (safeGlob(g)) out.push(String(g).trim());
    else errors.push(`${where}: "${g}" is not a usable repo-relative glob`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing — built from validated values, never copied from the reply
// ---------------------------------------------------------------------------

export function soulFile(a) {
  const meta = [
    '---',
    `name: ${a.name}`,
    `role: ${yamlScalar(a.role)}`,
    `priority: ${a.priority}`,
    `parallel: ${a.parallel}`,
    a.owns.length ? ['owns:', ...a.owns.map((g) => `  - "${g}"`)].join('\n') : 'owns: []',
    a.escalatesTo ? `escalates_to: ${a.escalatesTo}` : null,
    a.terminal ? 'terminal: true' : null,
    a.fixesBuild ? 'fixes_build: true' : null,
    `attempts: ${a.attempts}`,
    '---',
  ].filter((l) => l !== null);
  return `${meta.join('\n')}\n\n${a.soul}\n`;
}

/** Quote anything YAML would read as something other than a plain string. */
function yamlScalar(s) {
  // Defence in depth: callers pass one-line values, but a raw line break must
  // never reach front matter whatever the caller did.
  const v = String(s).replace(/[\r\n\u2028\u2029]+/g, ' ');
  return /[:#&*!|>'"%@`{}[\],]|^\s|\s$|^(true|false|null|yes|no|~|-?\d)/i.test(v)
    ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : v;
}

/**
 * The generated guard file.
 *
 * Only ever ADDS protection: a protected-paths list and a checkpoint list.
 * It is a separate file beside the repo's own hooks.yaml, so deleting it
 * removes exactly what generation added, and the sealed hooks in hooks.js are
 * untouched either way.
 */
export function guardFile(guards) {
  const lines = [
    '# Written by `jr-arch /prompt` from your answers. Edit or delete freely —',
    '# this file only ever adds protection, and hooks.yaml still applies.',
    '',
    'pre_edit:',
  ];
  if (guards.protectedPaths.length) {
    lines.push(
      '  - name: project-protected-paths',
      '    description: Files you said agents must never change.',
      '    severity: block',
      '    overridable: true',
      '    paths:',
      ...guards.protectedPaths.map((g) => `      - "${g}"`),
    );
  }
  if (guards.checkpointPaths.length) {
    lines.push(
      '  - name: project-checkpoints',
      '    description: Edits that wait for your approval.',
      '    severity: warn',
      '    overridable: true',
      '    checkpoint: true',
      '    paths:',
      ...guards.checkpointPaths.map((g) => `      - "${g}"`),
    );
  }
  if (!guards.protectedPaths.length && !guards.checkpointPaths.length) {
    lines.push('  []');
  }
  return `${lines.join('\n')}\n`;
}

export function writePlan(plan, { dir = agentDir(), replace = false } = {}) {
  const base = join(dir, 'agents');
  if (replace) {
    for (const a of readAgents(dir)) rmSync(a.dir, { recursive: true, force: true });
  }
  mkdirSync(base, { recursive: true });

  const written = [];
  const skipped = [];
  for (const a of plan.agents) {
    const target = join(base, a.name);
    if (existsSync(target) && !replace) { skipped.push(a.name); continue; }
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SOUL.md'), soulFile(a));
    writeFileSync(join(target, 'RULES.md'), `# Rules — ${a.name}\n\n${a.rules}\n`);
    written.push(a.name);
  }

  const hasGuards = plan.guards.protectedPaths.length || plan.guards.checkpointPaths.length;
  if (hasGuards) {
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'project.yaml'), guardFile(plan.guards));
  }

  return { written, skipped, guards: Boolean(hasGuards) };
}

// ---------------------------------------------------------------------------
// Assigning models
// ---------------------------------------------------------------------------

/**
 * Write per-agent model choices into agent.yaml's `tiers:` block.
 *
 * In the user's manifest, never in the agent's own front matter: an agent can
 * be pulled from a URL, and an agent choosing where the user's code is sent is
 * the privacy claim inverted.
 */
export function writeTiers(assignments, { dir = agentDir() } = {}) {
  const entries = Object.entries(assignments).filter(([, v]) => v);
  if (!entries.length) return;
  const body = entries.map(([name, m]) => [
    `${name}:`,
    '  model:',
    `    provider: ${m.provider}`,
    `    name: ${m.model}`,
    `    api_key_env: ${m.keyEnv}`,
    ...(m.baseUrl ? [`    base_url: ${m.baseUrl}`] : []),
  ].join('\n')).join('\n');

  const file = join(dir, 'agent.yaml');
  writeFileSync(file, upsertSection(readFileSync(file, 'utf8'), 'tiers', body));
}

async function assignModels(prompter, plan, { manifest, models, fetchImpl }) {
  const everyone = await prompter.confirm(
    `Use ${c.c(manifest.model)} for every agent?`,
    true,
  );
  if (everyone) return {};

  const assignments = {};
  const extra = new Map();   // keyEnv -> connection, so one key is only asked for once

  for (const a of plan.agents) {
    console.log();
    // The optional entry goes LAST. If it sat in the middle, a failed model
    // listing would renumber everything after it, and the same keypress would
    // pick a different thing depending on the network.
    const choice = await prompter.choose(`Model for ${c.c(a.name)} ${c.d(`— ${a.role}`)}`, [
      { value: 'same', label: `${manifest.model}`, note: 'the default' },
      { value: 'other', label: 'a different provider or API key' },
      ...(models?.length ? [{ value: 'list', label: 'another model on the same key' }] : []),
    ]);

    if (choice === 'same' || choice === null) continue;

    if (choice === 'list') {
      const id = await pickModel(prompter, { models, provider: manifest.provider });
      if (id) assignments[a.name] = { provider: manifest.provider, model: id, keyEnv: manifest.keyEnv, baseUrl: manifest.baseUrl };
      continue;
    }

    const conn = await obtainKey(prompter, { fetchImpl });
    if (!conn) continue;
    const id = await pickModel(prompter, conn);
    if (!id) continue;
    if (conn.key && !extra.has(conn.keyEnv)) {
      ensureIgnored();
      writeKey(conn.keyEnv, conn.key);
      process.env[conn.keyEnv] = conn.key;
      extra.set(conn.keyEnv, conn);
    }
    assignments[a.name] = { provider: conn.provider, model: id, keyEnv: conn.keyEnv, baseUrl: conn.baseUrl };
  }
  return assignments;
}

// ---------------------------------------------------------------------------
// The whole of /prompt
// ---------------------------------------------------------------------------

export async function promptMode(prompter, { call = callModel, fetchImpl = fetch, models = [], root = repoRoot() } = {}) {
  const dir = agentDir();
  const manifest = readManifest(join(dir, 'agent.yaml'));

  // Load the model list if this session has not already. Without it, "another
  // model on the same key" drops out of the per-agent menu and every option
  // after it renumbers — so the same keypress picks something different
  // depending on whether setup happened to run in this session.
  if (!models?.length) {
    try {
      models = await listModels(manifest.provider, process.env[manifest.keyEnv] ?? '', {
        baseUrl: manifest.baseUrl, fetchImpl,
      });
    } catch {
      models = [];
    }
  }

  const answers = await interview(prompter, { root });
  if (!answers) return null;

  console.log();
  process.stdout.write(`  ${c.d(`Designing agents with ${manifest.model}…`)} `);
  let result;
  try {
    result = await generatePlan(answers, manifest, { call });
  } catch (e) {
    console.log(c.r('failed'));
    warn(e.message);
    return null;
  }
  if (!result.plan) {
    console.log(c.r('failed'));
    warn('The model could not produce a usable plan:');
    for (const e of result.errors.slice(0, 6)) info(`  ${e}`);
    info('Try again with more detail, or use /dev to write the agents yourself.');
    return null;
  }
  console.log(c.g('done'));

  const { plan } = result;
  preview(plan);

  if (!(await prompter.confirm('Write these agents?', true))) {
    info('Nothing was written.');
    return null;
  }

  const existing = readAgents(dir);
  let replace = false;
  if (existing.length) {
    replace = await prompter.confirm(
      `Replace the ${existing.length} existing agent${existing.length === 1 ? '' : 's'} (${existing.map((a) => a.name).join(', ')})?`,
      true,
    );
  }

  const out = writePlan(plan, { dir, replace });
  ok(`Wrote ${out.written.length} agent${out.written.length === 1 ? '' : 's'}${out.guards ? ' and hooks/project.yaml' : ''}`);
  if (out.skipped.length) warn(`Kept existing: ${out.skipped.join(', ')} — not overwritten`);

  console.log();
  const assignments = await assignModels(prompter, plan, { manifest, models, fetchImpl });
  writeTiers(assignments, { dir });
  if (Object.keys(assignments).length) {
    ok(`Models set for ${Object.keys(assignments).join(', ')}`);
    info(c.d('Agents on different models share one context record — a handoff between them carries what was learned, not a transcript.'));
  }

  printTree(dir);
  info(`Try one:  ${c.c(`jr-arch smoke ${out.written[0]}`)}   or type a task below.`);
  return { plan, ...out, assignments };
}

function preview(plan) {
  console.log();
  console.log(`  ${c.b('Proposed agents')}`);
  for (const a of [...plan.agents].sort((x, y) => x.priority - y.priority)) {
    const route = a.terminal ? 'asks you' : a.escalatesTo ? `→ ${a.escalatesTo}` : '→ next';
    console.log(`   ${c.c(a.name.padEnd(18))} ${a.role}`);
    const bits = [
      `priority ${a.priority}`,
      a.owns.length ? `owns ${a.owns.join(' ')}` : 'owns anything',
      a.parallel ? 'parallel' : '',
      a.fixesBuild ? 'fixes builds' : '',
      route,
    ].filter(Boolean);
    console.log(`   ${' '.repeat(18)} ${c.d(bits.join(' · '))}`);
  }
  if (plan.guards.protectedPaths.length) {
    console.log();
    console.log(`  ${c.b('Never changed')}  ${plan.guards.protectedPaths.join(', ')}`);
  }
  if (plan.guards.checkpointPaths.length) {
    console.log(`  ${c.b('Needs approval')} ${plan.guards.checkpointPaths.join(', ')}`);
  }
  for (const n of plan.notes) warn(n);
  console.log();
}
