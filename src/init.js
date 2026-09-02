import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATES, agentDir, repoRoot } from './paths.js';
import { c, ok, info, warn } from './util.js';

const PROVIDERS = {
  anthropic:            { key: 'ANTHROPIC_API_KEY',  model: 'claude-sonnet-4-6',  base: null },
  openai:               { key: 'OPENAI_API_KEY',     model: 'gpt-4o',             base: null },
  ollama:               { key: 'OLLAMA_API_KEY',     model: 'qwen2.5-coder:14b',  base: 'http://localhost:11434/v1' },
  'openai-compatible':  { key: 'LLM_API_KEY',        model: null,                 base: null },
};

const MINIMAL = ['agent.yaml', 'SOUL.md', 'RULES.md'];

export async function init(flags) {
  const root = repoRoot();
  const dir = agentDir();

  if (existsSync(dir) && !flags.force) {
    throw new Error(`.gitagent/ already exists at ${dir}\n  Use --force to overwrite, or edit the files directly.`);
  }

  const provider = flags.provider || 'anthropic';
  if (!PROVIDERS[provider]) {
    throw new Error(`Unknown provider "${provider}". One of: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  const p = PROVIDERS[provider];
  const model = flags.model || p.model;
  const baseUrl = flags['base-url'] || p.base;

  if (!model) throw new Error(`Provider "${provider}" has no default model. Pass --model.`);
  if (provider === 'openai-compatible' && !baseUrl) {
    throw new Error('Provider "openai-compatible" requires --base-url.');
  }

  mkdirSync(dir, { recursive: true });

  if (flags.minimal) {
    for (const f of MINIMAL) cpSync(join(TEMPLATES, f), join(dir, f));
  } else {
    cpSync(TEMPLATES, dir, { recursive: true });
  }

  // Patch agent.yaml. Scope edits to the model: block — `name:` also appears
  // under metadata:, and a file-wide replace clobbers it.
  const manifestPath = join(dir, 'agent.yaml');
  const text = readFileSync(manifestPath, 'utf8');
  const manifest = text.replace(/^model:\n(?:[ \t]+.*\n|\n)*/m, (block) =>
    block
      .replace(/^(\s*provider:).*$/m,    `$1 ${provider}`)
      .replace(/^(\s*name:).*$/m,        `$1 ${model}`)
      .replace(/^(\s*api_key_env:).*$/m, `$1 ${p.key}`)
      .replace(/^(\s*base_url:).*$/m,    `$1 ${baseUrl ?? 'null'}`)
  );
  writeFileSync(manifestPath, manifest);

  // Never let a key land in git.
  const gitignore = join(root, '.gitignore');
  const rules = ['.gitagent/.env', '.gitagent/.session/'];
  const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const missing = rules.filter((r) => !current.includes(r));
  if (missing.length) {
    appendFileSync(gitignore, `${current && !current.endsWith('\n') ? '\n' : ''}\n# jr-architect\n${missing.join('\n')}\n`);
  }

  ok(`Scaffolded ${c.c('.gitagent/')} in ${root}`);
  console.log();
  info(`provider   ${provider}`);
  info(`model      ${model}`);
  if (baseUrl) info(`base_url   ${baseUrl}`);
  info(`api key    read from $${p.key}`);
  console.log();

  if (!flags.minimal) {
    info('tiers      build-doctor, senior-dev, junior-dev, ui-editor');
    info('guardrails .gitagent/hooks/hooks.yaml');
  }
  console.log();

  if (!process.env[p.key]) {
    warn(`$${p.key} is not set. Export it before running the agent.`);
  }

  console.log(c.b('Next:'));
  info('edit .gitagent/agents/*/RULES.md to shape each tier');
  info('edit .gitagent/hooks/hooks.yaml to set guardrails');
  info('run  jr-architect doctor   to verify your model can drive the tiers');
}
