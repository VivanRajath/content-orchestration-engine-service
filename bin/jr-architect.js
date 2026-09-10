#!/usr/bin/env node
import { init } from '../src/init.js';
import { config } from '../src/config.js';
import { personas } from '../src/personas.js';
import { doctor } from '../src/doctor.js';
import { pull } from '../src/pull.js';
import { c } from '../src/util.js';

const HELP = `
${c.b('jr-architect')} — Jr Architect coding agent in your terminal

  ${c.d('Scaffolds a GAP-format .gitagent/ folder into your repo.')}
  ${c.d('Your model, your key, your rules. Nothing leaves your machine except')}
  ${c.d('the calls you configure to your own provider.')}

${c.b('USAGE')}
  npx jr-architect <command> [options]

${c.b('COMMANDS')}
  init                  Scaffold .gitagent/ into the current repo
  config                Show or set model / provider / key env var
  personas              List, add, or remove persona tiers
  pull                  Update the installed pack, keeping your edits
  doctor                Probe the configured model for required capabilities

${c.b('INIT OPTIONS')}
  --from <git-url>      Install an agent pack from a git repo
  --ref <branch|sha>    Pin the pack to a branch, tag, or commit
  --provider <name>     anthropic | openai | ollama | openai-compatible
  --model <name>        Model identifier
  --base-url <url>      For ollama, vLLM, OpenRouter, LM Studio
  --minimal             Only agent.yaml, SOUL.md, RULES.md
  --force               Overwrite an existing .gitagent/

${c.b('PULL OPTIONS')}
  --ref <branch|sha>    Update to a specific branch, tag, or commit
  --dry-run             Show what would change, write nothing
  --force               Overwrite locally-edited files too

${c.b('EXAMPLES')}
  npx jr-architect init
  npx jr-architect init --from https://github.com/VivanRajath/gitagent-default
  npx jr-architect init --provider ollama --model qwen2.5-coder:14b \\
      --base-url http://localhost:11434/v1
  jr-architect pull --dry-run
  jr-architect personas add reviewer
  jr-architect config set model.name gpt-4o
  jr-architect doctor
`;

const argv = process.argv.slice(2);
const cmd = argv[0];

const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  } else positional.push(a);
}

try {
  switch (cmd) {
    case 'init':     await init(flags); break;
    case 'config':   await config(positional, flags); break;
    case 'personas': await personas(positional, flags); break;
    case 'pull':     await pull(positional, flags); break;
    case 'doctor':   await doctor(flags); break;
    case '-v':
    case '--version': console.log('0.1.0'); break;
    case undefined:
    case '-h':
    case '--help':   console.log(HELP); break;
    default:
      console.error(c.r(`Unknown command: ${cmd}`));
      console.log(HELP);
      process.exit(1);
  }
} catch (err) {
  console.error(c.r('✗ ') + err.message);
  process.exit(1);
}
