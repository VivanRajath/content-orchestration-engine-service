#!/usr/bin/env node
import { init } from '../src/init.js';
import { config, readManifest } from '../src/config.js';
import { personas } from '../src/personas.js';
import { doctor } from '../src/doctor.js';
import { pull } from '../src/pull.js';
import { run } from '../src/run.js';
import { detect } from '../src/detect.js';
import { loadEnv, key } from '../src/env.js';
import { c } from '../src/util.js';

const HELP = `
${c.b('jr-arch')} — Jr Architect coding agent in your terminal

  ${c.d('Scaffolds a GAP-format .gitagent/ folder into your repo.')}
  ${c.d('Your model, your key, your rules. Nothing leaves your machine except')}
  ${c.d('the calls you configure to your own provider.')}

${c.b('USAGE')}
  npx jr-arch <command> [options]

${c.b('COMMANDS')}
  init                  Scaffold .gitagent/ into the current repo
  run "<task>"          Run the agent on a task
  config                Show or set model / provider / key env var
  key [<value>]         Store your API key, or show whether one is set
  personas              List, add, or remove persona tiers
  pull                  Update the installed pack, keeping your edits
  detect                Report the stack, verify command, and lockfile state
  doctor                Probe the configured model for required capabilities

${c.b('INIT OPTIONS')}
  --from <git-url>      Install an agent pack from a git repo
  --ref <branch|sha>    Pin the pack to a branch, tag, or commit
  --provider <name>     anthropic | openai | ollama | openai-compatible
  --model <name>        Model identifier
  --base-url <url>      For ollama, vLLM, OpenRouter, LM Studio
  --minimal             Only agent.yaml, SOUL.md, RULES.md
  --force               Overwrite an existing .gitagent/

${c.b('RUN OPTIONS')}
  --dry-run             Classify and report the tier, change nothing
  --allow-dirty         Run with uncommitted changes (they can be lost)
  --skip-verify         Do not run the build/test command first
  --yes                 Approve human checkpoints without asking
  --no-stream           Do not stream model output as it arrives
  --resume [<id>]       Continue a stopped session, carrying its failed diffs

${c.b('KEY OPTIONS')}
  --env <NAME>          Use a different variable than the manifest names
  key remove            Delete the stored key

${c.b('DETECT OPTIONS')}
  --json                Machine-readable output

${c.b('PULL OPTIONS')}
  --ref <branch|sha>    Update to a specific branch, tag, or commit
  --dry-run             Show what would change, write nothing
  --force               Overwrite locally-edited files too

${c.b('EXAMPLES')}
  npx jr-arch run "add a --json flag to the status command"
  npx jr-arch run "make the header sticky" --dry-run
  npx jr-arch run --resume
  npx jr-arch detect
  npx jr-arch init
  npx jr-arch init --from https://github.com/VivanRajath/gitagent-default
  npx jr-arch key sk-ant-...
  npx jr-arch config set model.name gpt-4o
  npx jr-arch init --provider ollama --model qwen2.5-coder:14b \\
      --base-url http://localhost:11434/v1
  jr-arch pull --dry-run
  jr-arch personas add reviewer
  jr-arch config set model.name gpt-4o
  jr-arch doctor
`;

const argv = process.argv.slice(2);
const cmd = argv[0];

/**
 * Flags that never take a value. Without this list `run --dry-run "add a
 * thing"` reads the task as the flag's argument and the task is silently lost.
 * Hand-rolled parsing is deliberate here — the zero-dep property is the point —
 * but "does this flag take a value" is not something a parser can infer.
 */
const BOOLEAN = new Set([
  'dry-run', 'force', 'minimal', 'yes', 'no-stream',
  'allow-dirty', 'skip-verify', 'help', 'version', 'json',
]);

const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!BOOLEAN.has(key) && next && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  } else positional.push(a);
}

// Before any command that talks to a provider. The shell still wins: this
// only fills a variable the environment left unset.
loadEnv();

try {
  switch (cmd) {
    case 'init':     await init(flags); break;
    case 'config':   await config(positional, flags); break;
    case 'personas': await personas(positional, flags); break;
    case 'run':      await run(positional, flags); break;
    case 'detect':   await detect(positional, flags); break;
    case 'key':      await key(positional, flags, { manifest: readManifest() }); break;
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
