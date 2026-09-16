#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { init } from '../src/init.js';
import { config, readManifest } from '../src/config.js';
import { personas } from '../src/personas.js';
import { doctor } from '../src/doctor.js';
import { pull } from '../src/pull.js';
import { run } from '../src/run.js';
import { detect } from '../src/detect.js';
import { loadEnv, key } from '../src/env.js';
import { addAgent, addGuard } from '../src/add.js';
import { chat } from '../src/chat.js';
import { smoke } from '../src/smoke.js';
import { limits } from '../src/limits.js';
import { c } from '../src/util.js';

/**
 * The one place the version lives is package.json.
 *
 * It used to be typed here as well, and the two drifted the first time the
 * package was bumped — a published 0.1.1 whose `--version` still said 0.1.0.
 * npm always ships package.json, so this resolves in an installed copy too.
 */
const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

const HELP = `
${c.b('jr-arch')} — Jr Architect coding agent in your terminal

  ${c.d('Scaffolds a GAP-format .gitagent/ folder into your repo.')}
  ${c.d('Your model, your key, your rules. Nothing leaves your machine except')}
  ${c.d('the calls you configure to your own provider.')}

${c.b('USAGE')}
  npx jr-arch <command> [options]

${c.b('START HERE')}
  npx jr-arch            ${c.d('Sets everything up, one step at a time, then opens the chat')}

${c.b('IN THE CHAT')}
  /prompt               Describe what you need — agents are written for you
  /dev                  Write your own agents and guardrails
  /chat                 Type a task and an agent edits the code
  /help                 Everything else

${c.b('COMMANDS')}
  run "<task>"          Run one task without opening the chat
  smoke [agent]         Check an agent actually works
  add-agent <git-url>   Install an agent
  add-guard <git-url>   Install a guardrail file
  agents                List installed agents
  key [<value>]         Store an API key, or show which are set
  limits [set|unset]    Provider rate limits, and each agent's reply cap
  config                Show or change model, provider, and routing
  init                  Scaffold .gitagent/ without the guided setup
  detect                Report the stack, verify command, and lockfile state
  pull                  Update an installed pack, keeping your edits
  doctor                Check your model can drive the agents

${c.b('OPTIONS')}
  --agent <name>        Send the task to one named agent
  --swarm               Fan out to every agent whose scope the task touches
  --dry-run             Say what would happen, change nothing
  --resume [<id>]       Continue a stopped session
  --from <git-url>      Source for init / add-agent / add-guard
  --as <name>           Install under a different name
  --ref <branch|sha>    Pin to a branch, tag, or commit
  --model <name>        Model for init
  --provider <name>     anthropic | groq | openai | openrouter | xai | ollama | openai-compatible
  --base-url <url>      For ollama, vLLM, OpenRouter, LM Studio
  --env <NAME>          Which variable the key command writes
  --yes                 Approve human checkpoints without asking
  --no-git              Run without a branch or rollback (a failed attempt keeps its edits)
  --force               Overwrite what is already there
  --json                Machine-readable output where it applies
  --offline             For smoke: check files and keys, skip the model call

${c.b('EXAMPLES')}
  npx jr-arch init
  npx jr-arch key sk-ant-...
  npx jr-arch                                 ${c.d('# opens the chat')}

  jr-arch add-agent https://github.com/you/my-reviewer
  jr-arch add-guard https://github.com/you/strict-guards
  jr-arch run "add a --json flag" --agent <name>
  jr-arch config set model.name gpt-4o
  jr-arch limits                              ${c.d('# what this key allows')}
  jr-arch limits set junior-dev 2048          ${c.d('# cap one agent')}
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
  'dry-run', 'force', 'minimal', 'yes', 'no-stream', 'no-git',
  'allow-dirty', 'skip-verify', 'help', 'version', 'json', 'swarm', 'offline',
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
    case 'init':      await init(flags); break;
    case 'run':       await run(positional, flags); break;
    case 'chat':      await chat(positional, flags); break;
    case 'add-agent': await addAgent(positional, flags); break;
    case 'add-guard': await addGuard(positional, flags); break;
    case 'agents':    await personas(['list', ...positional], flags); break;
    case 'personas':  await personas(positional, flags); break;
    case 'key':       await key(positional, flags, { manifest: readManifest() }); break;
    case 'limits':    await limits(positional, flags); break;
    case 'config':    await config(positional, flags); break;
    case 'detect':    await detect(positional, flags); break;
    case 'pull':      await pull(positional, flags); break;
    case 'smoke':     await smoke(positional, flags); break;
    case 'doctor':    await doctor(flags); break;
    case '-v':
    case '--version': console.log(VERSION); break;
    case undefined:   await chat(positional, flags); break;
    case '-h':
    case '--help':    console.log(HELP); break;
    default:
      console.error(c.r(`Unknown command: ${cmd}`));
      console.log(HELP);
      process.exit(1);
  }
} catch (err) {
  console.error(c.r('✗ ') + err.message);
  process.exit(1);
}
