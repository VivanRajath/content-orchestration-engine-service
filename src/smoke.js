import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './paths.js';
import { readManifest, modelFor } from './config.js';
import { readAgents, findAgent, frontMatter, escalatesTo } from './agents.js';
import { loadHooks } from './hooks.js';
import { callModel, apiKey, requiresKey } from './provider.js';
import { listModels, KeyRejected } from './providers.js';
import { TOOLS } from './tools.js';
import { c, ok, info, warn } from './util.js';

/**
 * Does an agent actually work, before you give it a real task?
 *
 * Checks, cheapest first, and stops at the first one that makes the rest
 * meaningless — there is no point asking a model to call a tool when the key
 * is missing:
 *
 *   files      SOUL.md exists and its front matter parses
 *   routing    escalates_to names an installed agent
 *   guards     every guard file in hooks/ parses
 *   key        the agent's resolved key is present
 *   model      the provider answers, and knows the model
 *   tools      given the agent's real prompt, the model calls a tool
 *
 * The last check sends the agent's actual system prompt and asks it to call
 * done(). Nothing is written — done() is a control tool with no side effects —
 * so a smoke test is safe to run on any repo at any time.
 */

export async function smokeTest(name, { dir = agentDir(), call = callModel, fetchImpl = fetch, skipNetwork = false } = {}) {
  const results = [];
  const pass = (check, detail) => results.push({ check, ok: true, detail });
  const fail = (check, detail) => { results.push({ check, ok: false, detail }); return summary(); };
  const note = (check, detail) => results.push({ check, ok: true, warn: true, detail });
  const summary = () => ({ agent: name, ok: results.every((r) => r.ok), results });

  const agents = readAgents(dir);
  const agent = findAgent(name, agents);
  if (!agent) {
    return fail('files', `no agent "${name}" — installed: ${agents.map((a) => a.name).join(', ') || 'none'}`);
  }

  // files
  const soulPath = join(agent.dir, 'SOUL.md');
  const raw = readFileSync(soulPath, 'utf8');
  const { meta, body } = frontMatter(raw);
  if (/^---/.test(raw) && !Object.keys(meta).length) {
    return fail('files', 'SOUL.md front matter did not parse — check indentation (spaces, not tabs)');
  }
  if (!body.trim()) return fail('files', 'SOUL.md has front matter but no body — the model would be told nothing');
  pass('files', `SOUL.md parses${agent.role ? ` · ${agent.role}` : ''}`);
  if (!agent.hasRules) note('files', 'no RULES.md — the agent has identity but no stated constraints');

  // routing
  if (agent.escalatesTo && !findAgent(agent.escalatesTo, agents)) {
    return fail('routing', `escalates_to "${agent.escalatesTo}" is not installed`);
  }
  const next = escalatesTo(agent, agents);
  pass('routing', agent.terminal ? 'terminal — stops and asks you' : next ? `escalates to ${next}` : 'last by priority — stops and asks you');

  // guards
  try {
    const hooks = loadHooks(dir, { reload: true });
    pass('guards', `${hooks.files.length} guard file${hooks.files.length === 1 ? '' : 's'} load`);
    for (const n of hooks.notes) note('guards', n);
  } catch (e) {
    return fail('guards', e.message);
  }

  // key
  const manifest = readManifest(join(dir, 'agent.yaml'));
  const m = modelFor(manifest, name);
  const key = apiKey(m);
  if (!key && requiresKey(m)) {
    return fail('key', `$${m.keyEnv} is not set — jr-arch key <your-key>${m.keyEnv !== manifest.keyEnv ? ` --env ${m.keyEnv}` : ''}`);
  }
  pass('key', requiresKey(m) ? `$${m.keyEnv} is set` : `${m.provider} needs no key`);

  if (skipNetwork) return summary();

  // model
  try {
    const models = await listModels(m.provider, key, { baseUrl: m.baseUrl, fetchImpl });
    if (models.length && !models.some((x) => x.id === m.model)) {
      return fail('model', `${m.provider} does not list "${m.model}" for this key`);
    }
    pass('model', `${m.model} on ${m.provider}`);
  } catch (e) {
    if (e instanceof KeyRejected) return fail('model', e.message);
    // Some OpenAI-compatible servers have no /models route at all. That is not
    // a reason to fail an agent the chat call below may still drive fine.
    note('model', `could not list models (${e.message}) — trying the call anyway`);
  }

  // tools
  try {
    const reply = await call(m, {
      system: `${body}\n\n---\n\nThis is a connectivity check. Do not read or change any files.`,
      messages: [{ role: 'user', content: 'Call the done tool now, with the summary "smoke ok".' }],
      tools: TOOLS,
      maxTokens: 300,
      temperature: 0,
    });
    const done = reply.toolCalls.find((t) => t.name === 'done');
    if (done) pass('tools', 'the model called a tool with the agent\'s real prompt');
    else if (reply.toolCalls.length) pass('tools', `the model called ${reply.toolCalls[0].name} — tool calling works`);
    else return fail('tools', 'the model replied in prose and called no tool — it cannot drive an agent. Try another model.');
  } catch (e) {
    return fail('tools', `the call failed: ${e.message}`);
  }

  return summary();
}

export function printSmoke(result) {
  console.log();
  console.log(`  ${c.b(`smoke test · ${result.agent}`)}`);
  for (const r of result.results) {
    const mark = !r.ok ? c.r('✗') : r.warn ? c.y('!') : c.g('✓');
    console.log(`  ${mark} ${c.d(r.check.padEnd(8))} ${r.detail}`);
  }
  console.log();
  if (result.ok) ok(`${result.agent} is ready`);
  else warn(`${result.agent} is not ready — fix the ✗ above and run it again`);
  console.log();
}

/** `jr-arch smoke [agent]` — one agent, or every installed agent. */
export async function smoke(positional, flags) {
  const dir = agentDir();
  if (!existsSync(join(dir, 'agent.yaml'))) throw new Error('No .gitagent/ found. Run `jr-arch` to set one up.');
  const names = positional?.length ? positional : readAgents(dir).map((a) => a.name);
  if (!names.length) throw new Error('No agents installed.');

  let allOk = true;
  for (const name of names) {
    const r = await smokeTest(name, { dir, skipNetwork: Boolean(flags.offline) });
    printSmoke(r);
    allOk &&= r.ok;
  }
  if (!allOk) process.exitCode = 1;
}
