import { readManifest } from './config.js';
import { c, ok, info, warn } from './util.js';

/**
 * The tiers need strict JSON and tool calling. Plenty of local models give
 * neither, and the escalation ladder then degrades into retry thrash that
 * looks like a bug in this tool. Probe at setup, not mid-task.
 */

const PROBE_JSON = 'Reply with only this JSON object and nothing else: {"tier":"junior-dev","confidence":0.9}';

const TOOL = {
  name: 'read_file',
  description: 'Read a file from the repository',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

async function callAnthropic(m, key, body) {
  const res = await fetch((m.baseUrl || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: m.model, max_tokens: 256, ...body }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function callOpenAI(m, key, body) {
  const base = m.baseUrl || 'https://api.openai.com/v1';
  const res = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: m.model, max_tokens: 256, ...body }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function doctor() {
  const m = readManifest();
  const key = process.env[m.keyEnv] || '';

  console.log();
  info(`provider  ${m.provider}`);
  info(`model     ${m.model}`);
  info(`endpoint  ${m.baseUrl || 'provider default'}`);
  console.log();

  const isAnthropic = m.provider === 'anthropic';
  if (!key && m.provider !== 'ollama') {
    throw new Error(`$${m.keyEnv} is not set.`);
  }

  let jsonPass = false;
  let toolPass = false;

  // 1. structured output
  try {
    const body = isAnthropic
      ? { messages: [{ role: 'user', content: PROBE_JSON }] }
      : { messages: [{ role: 'user', content: PROBE_JSON }] };
    const data = isAnthropic ? await callAnthropic(m, key, body) : await callOpenAI(m, key, body);
    const text = isAnthropic
      ? (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      : data.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    jsonPass = parsed.tier === 'junior-dev';
    jsonPass ? ok('structured output') : warn('structured output — parsed, but wrong shape');
  } catch (e) {
    warn(`structured output — failed (${e.message.slice(0, 80)})`);
  }

  // 2. tool calling
  try {
    const body = isAnthropic
      ? { tools: [TOOL], messages: [{ role: 'user', content: 'Read the file README.md' }] }
      : {
          tools: [{ type: 'function', function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.input_schema } }],
          messages: [{ role: 'user', content: 'Read the file README.md' }],
        };
    const data = isAnthropic ? await callAnthropic(m, key, body) : await callOpenAI(m, key, body);
    toolPass = isAnthropic
      ? (data.content || []).some((b) => b.type === 'tool_use')
      : Boolean(data.choices?.[0]?.message?.tool_calls?.length);
    toolPass ? ok('tool calling') : warn('tool calling — model did not call the tool');
  } catch (e) {
    warn(`tool calling — failed (${e.message.slice(0, 80)})`);
  }

  console.log();
  if (jsonPass && toolPass) {
    ok(c.b('Tiered mode supported.'));
    info('all four tiers and escalation are available');
  } else {
    warn(c.b('Tiered mode not recommended for this model.'));
    info('escalation would likely thrash between tiers');
    info(`set routing.entry to ${c.c('senior-dev')} in agent.yaml to run single-agent:`);
    info('  jr-architect config set routing.entry senior-dev');
  }
  console.log();
}
