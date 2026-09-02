import { readManifest } from './config.js';
import { callModel, apiKey, requiresKey, extractJson } from './provider.js';
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

export async function doctor() {
  const m = readManifest();

  console.log();
  info(`provider  ${m.provider}`);
  info(`model     ${m.model}`);
  info(`endpoint  ${m.baseUrl || 'provider default'}`);
  console.log();

  if (!apiKey(m) && requiresKey(m)) {
    throw new Error(`$${m.keyEnv} is not set.`);
  }

  let jsonPass = false;
  let toolPass = false;

  // 1. structured output
  try {
    const res = await callModel(m, {
      messages: [{ role: 'user', content: PROBE_JSON }],
      maxTokens: 256,
    });
    const parsed = extractJson(res.text);
    jsonPass = parsed?.tier === 'junior-dev';
    jsonPass ? ok('structured output') : warn('structured output — parsed, but wrong shape');
  } catch (e) {
    warn(`structured output — failed (${e.message.slice(0, 80)})`);
  }

  // 2. tool calling
  try {
    const res = await callModel(m, {
      tools: [TOOL],
      messages: [{ role: 'user', content: 'Read the file README.md' }],
      maxTokens: 256,
    });
    toolPass = res.toolCalls.length > 0;
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

  return { jsonPass, toolPass };
}
