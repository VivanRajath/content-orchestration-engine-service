# jr-arch

A coding agent that lives in your repo. Bring your own model and key. It edits
your code under guardrails you control, and nothing leaves your machine except
calls to the AI provider you choose.

```bash
npx jr-arch
```

That's the whole install. It asks for what it needs, one step at a time.

- **Node 18 or newer.** No other runtime dependencies.
- **A git repository** is strongly recommended. Every run works on its own
  branch, and failed attempts are rolled back through git.
- **An API key** for Anthropic, Groq, OpenAI, OpenRouter or xAI. You can also
  use a local Ollama or any OpenAI-compatible endpoint.

> Looking for how it works inside? See [ARCHITECTURE.md](ARCHITECTURE.md).
> Working on the code itself? See [RUNBOOK.md](RUNBOOK.md).

---

## Contents

- [Quick start](#quick-start)
- [Three ways to work](#three-ways-to-work)
- [Commands](#commands)
- [Flags](#flags)
- [Chat commands](#chat-commands)
- [Bring your own model](#bring-your-own-model)
- [Agents](#agents)
- [Guardrails](#guardrails)
- [Running tasks safely](#running-tasks-safely)
- [Context between models](#context-between-models)
- [What's in `.gitagent/`](#whats-in-gitagent)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Privacy](#privacy)

---

## Quick start

### Interactive (recommended)

```bash
cd your-repo
npx jr-arch
```

```
  Step 1 of 4  Connect an AI provider
  API key: ****************************************************
✓ That looks like a Groq key gsk_… (56 chars)
  Checking the key… works
✓ 18 models available

  Step 2 of 4  Choose a model
    1  openai/gpt-oss-120b
    2  qwen/qwen3-32b
    3  llama-3.3-70b-versatile
    …

  Step 3 of 4  Create your agent folder
✓ Created .gitagent/
    agents/  hooks/  agent.yaml  DUTIES.md  .env

  Step 4 of 4  How do you want to start?
    1  /prompt  describe what you need      agents are written for you
    2  /dev     write your own agents       and set guardrails by hand
    3  /chat    start with the default agents
```

Your key is **checked by listing the models it can reach**. A wrong key gets
caught here instead of failing on your first task, and you only ever pick from
models your key can use. The key is masked as you type or paste it.

### Non-interactive (CI, scripts, no TTY)

```bash
npx jr-arch init --provider groq --model llama-3.3-70b-versatile
npx jr-arch key gsk_...
npx jr-arch doctor                       # can this model drive the agents?
npx jr-arch run "add a --json flag to the status command"
```

With no terminal attached, `jr-arch` explains what to run instead of waiting on
a prompt nobody can answer.

---

## Three ways to work

Once you're set up, `jr-arch` opens a chat. You can switch modes at any time.

### `/prompt`: describe it, get agents

Answer a few questions and your model designs a team of agents for this repo:

```
  What should your coding agents do?
  › Build and maintain a REST API that takes card payments
  What kind of project is this?  (Node, Express)
  Which files or folders must agents never change?
  › payments/keys/**, .github/**
  How should agents check their work?  (npm run test)
  How many agents?  1 Decide for me  2 One agent  3 A team

  Proposed agents
   api-builder     Builds and changes REST endpoints
                   priority 20 · owns src/routes/** · parallel · → payments-lead
   test-writer     Writes and fixes tests
                   priority 20 · owns test/** · parallel · fixes builds
   payments-lead   Owns anything touching money
                   priority 80 · owns anything · asks you

  Never changed  payments/keys/**, .github/**
  Needs approval migrations/**

  Write these agents? [Y/n]
```

Next it asks which model each agent should use, and whether any of them should
run on a **different provider with its own key**. A common setup is a cheap,
fast model for scoped work and a stronger one for decisions.

You always see the plan before anything is written. The model only proposes the
plan. jr-arch validates every field and writes the files itself, so a bad
generation can't add an escalation loop, a guardrail that switches something
off, or a model you didn't choose.

If generation fails (a rate limit, or a model that can't return the JSON),
your interview answers are kept. You can retry, try another model, keep the
default agents, or switch to `/dev`.

### `/dev`: write your own

```
  /new reviewer      scaffold an agent: SOUL.md + RULES.md
  /guard strict      scaffold a guard file
  /edit reviewer     show where its files are
  /check             find problems before a run does
  /smoke reviewer    check it actually works
  @reviewer <task>   give it a task
```

`/check` catches mistakes that would otherwise fail silently mid-run. Examples:
an agent that escalates to an agent that isn't installed, two agents handing a
task back and forth forever, or a guard still full of `TODO`s that protects
nothing.

`/smoke` runs six checks against one agent, cheapest first:

```
  smoke test · reviewer
  ✓ files    SOUL.md parses · Reviews diffs before they land
  ✓ routing  escalates to payments-lead
  ✓ guards   2 guard files load
  ✓ key      $GROQ_API_KEY is set
  ✓ model    llama-3.3-70b-versatile on groq
  ✓ tools    the model called a tool with the agent's real prompt
✓ reviewer is ready
```

The last check sends the agent's real prompt and asks the model to call a tool.
Nothing is written, so it's safe on any repo. A model that answers in prose
instead of calling tools can't drive an agent, and it's better to find that out
before a real task.

### `/chat`: just give it tasks

```
  [chat] › add a --json flag to the status command
  api-builder · single-concern change to one route
    ✓ read_file   src/routes/status.js
    ✓ write_file  src/routes/status.js
    ✓ done
  ✓ verify passed (npm run test)
    commit  867b813
```

Type a task and the right agent picks it up, or send it to one agent with
`@name`.

---

## Commands

| Command | What it does |
|---|---|
| `jr-arch` | Guided setup on first run, then the chat |
| `jr-arch chat` | Open the chat explicitly. `--mode dev` starts in dev mode |
| `jr-arch run "<task>"` | Run one task without the chat |
| `jr-arch smoke [agent…]` | Check that one agent (or every agent) works. `--offline` skips the model calls |
| `jr-arch add-agent <git-url>` | Install an agent (a folder with `SOUL.md`) from a git repo |
| `jr-arch add-guard <git-url>` | Install a guard file (YAML hooks) from a git repo |
| `jr-arch agents` | List installed agents with priority, role, scope |
| `jr-arch personas list \| add <name> \| remove <name>` | Lower-level agent management. `add --from <url>` pulls one persona |
| `jr-arch key` | Show which keys are set and where each comes from |
| `jr-arch key <value>` | Store a key in `.gitagent/.env`. `--env <NAME>` picks the variable |
| `jr-arch key remove` | Remove a key from `.gitagent/.env` |
| `jr-arch limits` | Show what this key may spend, and each agent's reply cap. `--offline` skips the provider check |
| `jr-arch limits set <agent\|default> <n>` | Cap one agent's replies, or the default every agent inherits |
| `jr-arch limits unset <agent>` | Put an agent back on the default cap |
| `jr-arch config` | Show model, per-agent models, routing entry |
| `jr-arch config set <section.key> <value>` | Change one scalar in `agent.yaml`, e.g. `model.name gpt-4o` |
| `jr-arch init` | Scaffold `.gitagent/` without the guided setup |
| `jr-arch init --from <git-url>` | Scaffold from an agent pack instead of the bundled defaults |
| `jr-arch pull [<git-url>]` | Update an installed pack, keeping your local edits |
| `jr-arch detect` | Report the stack, verify command, lockfiles, CI, monorepo |
| `jr-arch doctor` | Probe the default model for strict JSON and tool calling |
| `jr-arch --version`, `-v` | Print the version |
| `jr-arch --help`, `-h` | Print help |

### Examples

```bash
# one-off tasks
jr-arch run "fix the failing date test"
jr-arch run "add a --json flag" --agent senior-dev
jr-arch run "update the api and its tests" --swarm
jr-arch run "rename the config loader" --dry-run     # classify only, change nothing
jr-arch run --resume                                 # continue the last stopped run
jr-arch run --resume 20260915-101500-ab12            # continue a specific one

# keys and models
jr-arch key sk-ant-...
jr-arch key --env OPENAI_API_KEY sk-...
jr-arch config set model.name qwen/qwen3-32b
jr-arch config set routing.entry auto

# agents and guards
jr-arch add-agent https://github.com/you/my-reviewer --as reviewer
jr-arch add-guard https://github.com/you/strict-guards --ref v1.2.0
jr-arch init --from https://github.com/VivanRajath/gitagent-default
jr-arch pull --dry-run
```

---

## Flags

A flag that takes a value reads the next token (`--agent reviewer`). Boolean
flags never do, so `run --dry-run "task"` keeps the task.

| Flag | Applies to | Meaning |
|---|---|---|
| `--agent <name>` | `run` | Send the task to one agent and skip classification |
| `--swarm` | `run` | Fan out to parallel agents whose scopes the task spans |
| `--dry-run` | `run`, `pull` | Say what would happen and change nothing |
| `--resume [<id>]` | `run` | Continue a stopped session. No id means the most recent |
| `--yes` | `run` | Approve human checkpoints without asking. Must be typed by a person |
| `--no-git` | `run` | Work without a branch or rollback. Only for a directory that is not a repo, or has no commits |
| `--allow-dirty` | `run` | Start even with uncommitted changes (the chat always passes this) |
| `--skip-verify` | `run` | Don't run the project's build/test command before starting |
| `--no-stream` | `run` | Buffer model output instead of streaming it |
| `--from <git-url>` | `init`, `add-agent`, `add-guard`, `personas add`, `pull` | Where to fetch from |
| `--ref <branch\|tag\|sha>` | same as `--from` | Pin to a ref |
| `--as <name>` | `add-agent`, `add-guard` | Install under a different name (single item only) |
| `--provider <id>` | `init` | `anthropic` · `groq` · `openai` · `openrouter` · `xai` · `ollama` · `openai-compatible` |
| `--model <name>` | `init` | Model id |
| `--base-url <url>` | `init` | Endpoint for Ollama, vLLM, LM Studio, or any OpenAI-compatible server |
| `--minimal` | `init` | Only `agent.yaml` and `DUTIES.md`, no bundled agents or hooks |
| `--force` | `init`, `add-agent`, `add-guard`, `personas add`, `pull` | Overwrite what is already there |
| `--env <NAME>` | `key` | Which environment variable to write or remove |
| `--offline` | `smoke`, `limits` | Skip the provider call: check files, routing, guards and keys only |
| `--json` | `detect` | Machine-readable output |
| `--mode <chat\|dev>` | `chat` | Starting mode |

---

## Chat commands

| Command | |
|---|---|
| `<task>` | The classifier picks an agent |
| `@name <task>` | Give the task to one agent |
| `/chat` · `/prompt` · `/dev` | Switch mode |
| `/key` | Add an API key (as many as you like) or change one; offers to switch provider |
| `/models` | Show each agent's model and key; switch the default, or put one agent on another key |
| `/limits` | Provider rate limits, each agent's reply cap, and set them |
| `/agents` | Installed agents |
| `/tree` | `.gitagent/` drawn with what each file is for |
| `/smoke [name]` | Smoke-test one agent or all |
| `/new <name>` · `/guard <name>` · `/edit <name>` · `/check` | Dev tools (work in any mode) |
| `/status` | Branch, build state, uncommitted files |
| `/undo` | Roll back the last commit (asks first) |
| `/help`, `/?` | Help |
| `/exit`, `/quit`, `/q`, Ctrl-D | Leave |

---

## Bring your own model

| Provider | Key looks like | Default key variable | |
|---|---|---|---|
| Anthropic | `sk-ant-…` | `ANTHROPIC_API_KEY` | |
| Groq | `gsk_…` | `GROQ_API_KEY` | |
| OpenRouter | `sk-or-…` | `OPENROUTER_API_KEY` | |
| xAI | `xai-…` | `XAI_API_KEY` | |
| OpenAI | `sk-…` | `OPENAI_API_KEY` | |
| Ollama | none | `OLLAMA_API_KEY` | type `ollama` instead of a key; runs locally |
| Anything OpenAI-compatible | anything | `LLM_API_KEY` | Together, vLLM, LM Studio… you give the URL |

When you paste a key, jr-arch recognises the provider from its prefix. The model
list is always fetched live from the provider. Nothing is hard-coded, so you're
never offered a model your key can't use. Speech, embedding, moderation and
image models are filtered out because they can't call tools.

### More than one key

Setup asks **"Add another API key?"** after the first one works, and keeps
asking until you say no. Each key is checked the same way — by listing its
models — and saved under its own provider's variable in `.gitagent/.env`. A
second key for a provider you already added gets its own name
(`GROQ_API_KEY_2`), so it never overwrites the first. Add more later with
`/key` in the chat, or `jr-arch key <value>` — a key is always filed under its
own provider, whatever the default is.

Nothing is assigned automatically: which agent uses which key is yours to
choose, because it decides where that agent sends your code. Use `/models` →
*One agent's model or key*, or pick when `/prompt` asks which model each agent
uses — saved keys are offered by name, so none is pasted twice.

`agent.yaml` lists the keys by provider and variable name under `keys:`, never
their values. It doubles as the list of every provider your code can be sent
to from this repo.

**Rate limits belong to the account, not the key.** Several keys from one Groq
account share one allowance, so they don't reduce waits. Keys from *different*
providers do: each agent on its own provider gets that provider's limit.

**Where your key lives.** `agent.yaml` stores the *name* of an environment
variable, never the key itself. The key goes in `.gitagent/.env`, and jr-arch
adds that file to `.gitignore` before writing to it (on POSIX systems the file
is mode 0600). A key exported in your shell always takes precedence over the
file. The agents can't read the key either: `.env*` is a sealed guardrail
path, so both `read_file` and `cat` are refused.

### Token limits

Pasting a key also tells you what the key may spend. jr-arch reads the rate
limits the provider reports and shows them before your first task, instead of
letting you find out as a 429 in the middle of one:

```
  Provider limits  Groq · llama-3.3-70b-versatile
    requests           14,400   14,398 left · resets in 3 min
    tokens             18,000   17,600 left · resets in 30s
```

There are two different numbers here, and it's worth keeping them apart:

- **Provider limits** are set by the plan your key belongs to. jr-arch only
  reports them.
- **The reply cap** (`max_tokens`) is the most one reply may generate. That one
  is yours to set, per agent.

The cap matters more than it looks. A provider refuses a request that merely
*asks* for more output tokens than your per-minute allowance, so a cap set too
high fails every task until you find the number; set too low, the model gets
cut off mid tool call. If the provider reports an output limit, setup fits the
default cap under it for you.

```bash
jr-arch limits                       # what the key allows, and every agent's cap
jr-arch limits set default 4000      # the cap every agent inherits
jr-arch limits set junior-dev 2048   # one agent only
jr-arch limits unset junior-dev      # back to inheriting
```

`/limits` does the same inside the chat. A cap is stored per agent in
`agent.yaml` under `tiers:`, so it survives and can be reviewed like any other
config.

### Working under a small limit

Free tiers are tight. A Groq key with 8,000 tokens a minute counts input and
output together, and an agent carries about 2,000 tokens of prompt and tool
schemas before it reads anything — so one 7,000-token README used to blow the
whole minute and fail the task.

jr-arch measures the limit at setup (`model.tokens_per_minute` in
`agent.yaml`), tells you what a step costs before spending anything, and fits
every request under it:

```
  [chat] › what does this repo do
  senior-dev · high-level question about the whole repo
    ~2.4k per step · 8.0k/min on this key · about 1 step a minute
```

- **`read_file` is capped by the budget**, not by a constant. A file that
  doesn't fit comes back in parts — `[index.html · lines 1-253 of 1019]` — and
  says exactly where the next part starts (`start_line=254`). A one-line
  (minified) file too long for a request is cut and says so.
- **The reply cap shrinks first** when a request is tight, because a shorter
  answer still answers.
- **Then the oldest tool output is dropped**, with a note in its place — the
  task and recent turns are what the model works from, and a dropped file can
  be read again.
- **If the prompt alone exceeds the budget, it stops before the first request**
  and says so, instead of failing four times on the way up the ladder.
- **Each step is fitted to what is left of the minute**, not to a fresh one. A
  per-minute limit is spent by every step together — each one resends the
  conversation — so the provider's own "tokens remaining" header, read from
  every response, is the budget the next step actually has.
- **When the minute is spent, it waits once, for exactly as long as the
  provider says**, instead of sending a request it will refuse and backing off
  blind. On a tight key `DUTIES.md` is also shortened (its preamble first, then
  later sections) — it is the largest part of every step.
- **A reply cut off because its cap was lowered is sent again with more room**,
  rather than handing the model its own half-written tool call.

- **An agent going round in circles is stopped.** On a small key an agent
  can read a part, have it dropped to make room, and read it again — one
  reported run spent a day's 200,000-token allowance that way on one file. The
  model is told its own replies survive while tool output does not, and to note
  what it needs as it goes; reading the same part a third time with nothing
  written in between stops the task.
- **A spent daily allowance stops the run at once**, rather than letting the
  next attempt ask to be told the same thing.

A per-minute limit is a per-minute limit: on an 8,000-a-minute key, an agent
gets two or three steps a minute however tightly it is packed. The waits get
shorter and never end in a refusal, but only a key or model with a higher
allowance removes them — reasoning models in particular spend output tokens
thinking before each tool call. `jr-arch limits` shows what yours allows.

Estimates are characters over a ratio, not a tokenizer (this project has no
dependencies). When a provider rejects a request it reports the true count,
and that number replaces the estimate's ratio for that model.

**If it's still too tight**, put the demanding agent on another provider's key
— per-agent models already do this, and each key keeps its own allowance:

```yaml
tiers:
  senior-dev:                 # the one that reads whole files
    model:
      provider: anthropic
      name: claude-sonnet-4-6
      api_key_env: ANTHROPIC_API_KEY
  junior-dev:                 # scoped work stays on the cheap key
    model:
      provider: groq
      name: llama-3.3-70b-versatile
      api_key_env: GROQ_API_KEY
```

Add the second key with `jr-arch key <value> --env ANTHROPIC_API_KEY`.

### A different model per agent

```yaml
# .gitagent/agent.yaml
tiers:
  api-builder:
    model:
      provider: groq
      name: llama-3.3-70b-versatile
      api_key_env: GROQ_API_KEY
  payments-lead:
    model:
      provider: anthropic
      name: claude-opus-4-1
      api_key_env: ANTHROPIC_API_KEY
```

`/prompt` writes this block for you. Any field an agent doesn't set is inherited
from the top-level `model:` block. The exception is `base_url`: an agent that
switches provider doesn't inherit it, so an Anthropic agent is never pointed at
an OpenAI-compatible URL.

### Provider limits

jr-arch recovers from provider limits where it can and explains the rest in
plain language:

- **Request too large** (for example Groq free tier: "Limit 1000, Requested
  2581"): jr-arch resends with a smaller `max_tokens` and remembers that cap for
  the rest of the process.
- **Short rate limit:** jr-arch waits it out (up to 90s) and shows a notice.
- **Daily limit, or a request that can't be shrunk:** jr-arch stops and tells
  you what to do: pick another model with `/models`, or upgrade your plan.

---

## Agents

An agent is a folder with two files: `SOUL.md` says who it is, and `RULES.md`
says what it must and must not do. The agent describes itself in front matter:

```yaml
---
name: reviewer
role: Reviews diffs before they land
priority: 20              # lower numbers claim work first (default 50)
owns: ["**/*.test.js"]    # files it claims; [] or omitted means anything
parallel: true            # may run beside agents with non-overlapping scope
escalates_to: lead        # who takes over when it runs out of attempts
terminal: true            # or: stop and ask you instead
fixes_build: true         # a red build comes here first
attempts: 2               # tries before escalating (default: routing.default_attempts)
---
```

The folder *is* the install. Create one and the agent exists; delete it and
it's gone. There's no list to keep in sync.

jr-arch ships four starter agents: `build-doctor`, `junior-dev`, `senior-dev`
and `ui-editor`. They're a default setup that you're expected to replace.
Replace them with `/prompt`, write your own with `/dev`, or pull one from GitHub:

```bash
jr-arch add-agent https://github.com/you/my-reviewer
jr-arch add-guard https://github.com/you/strict-guards
```

**An agent can't choose its model or key.** Agents can be pulled from any URL,
and letting one decide where your code gets sent would defeat the privacy
model. Model choice stays in your own `agent.yaml`. A pack whose
`gitagent.yaml` declares a model is refused outright.

### How a task is routed

1. `--agent` / `@name`: you picked the agent, so there's no model call.
2. `routing.entry` set to a specific agent: that agent always takes the task.
3. The build is red and an agent declares `fixes_build`: that agent takes it.
4. Otherwise one model call returns `{tier, confidence, reason}`, based on the
   rules in `DUTIES.md`. Below `classifier_confidence_floor` the task goes
   one step up, to whatever the classified agent `escalates_to`.

When an agent runs out of attempts, the task moves to its `escalates_to`, or to
the next agent by priority. A `terminal` agent stops and reports to you instead.

### Swarms

Agents that opt in with `parallel: true` and have **non-overlapping** `owns`
can work on one task at the same time:

```bash
jr-arch run "update the api and its tests" --swarm
```

They share the same context record. If one fails, only *its* files are rolled
back and the others' work stays. Swarms are opt-in because fanning out
multiplies your token bill.

---

## Guardrails

jr-arch enforces guardrails itself instead of relying on the model to follow
instructions. A model that ignores its own `RULES.md` still can't get past them.

| When | Guard | Stops | Can be turned off |
|---|---|---|---|
| edit | `secret-scan` | added lines containing API keys, private keys, or high-entropy strings | **no** |
| edit | `protected-paths` | `.env*`, `.git/`, `node_modules/`, lockfiles, CI workflows | yes |
| edit | `diff-ceiling` | a single edit over `max_lines` (asks you) | yes |
| edit | `scope-fence` | an agent editing outside its allow list | yes |
| command | `no-force-push` | force pushes and history rewrites | **no** |
| command | `protected-read` | reading `.env*`, `.git/`, `*.pem`, `id_rsa*`, `.npmrc`, AWS credentials | **no** |
| command | `no-sudo` | `sudo`, `doas`, `su`, `runas` | **no** |
| command | `no-exfil` | `curl`/`wget`/`scp`/`ssh`/… with a network destination | yes |
| command | `destructive` | `rm -rf`, `git clean -f`, `git checkout -- .`, `DROP TABLE` | yes |
| command | `dep-change` | adding, removing or bumping dependencies (asks you) | yes |
| commit | `build-gate` | committing a failing build | yes |

The four marked **no** are sealed in code. No guard file can disable them,
weaken them, or shorten their lists, whether you wrote it, pulled it, or
`/prompt` generated it. A file can only *add* to their lists.

Commands run with no shell: the model passes an argv array, so pipes,
redirects and `&&` are passed through as plain arguments and can't be used to
get around the command checks.

### Writing your own

Every `.yaml` file in `.gitagent/hooks/` is loaded, and guards are additive.
`hooks.yaml` loads last, so it wins over any file you pulled in. A guard is
enforced by what it declares, not by its name, so you can name it anything:

```yaml
pre_edit:
  - name: keep-payments-safe
    severity: block              # block · warn · checkpoint (stops and asks you)
    paths:
      - "payments/**"

pre_command:
  - name: no-terraform
    severity: checkpoint
    commands: ["terraform"]
    applies_to: [api-builder]    # optional: only these agents
```

An edit guard blocks changes but still lets agents *read* the file, since they
usually need to understand code they aren't allowed to touch. To block reading
too, put the path in a `pre_command` guard. That covers both `cat` and the
agent's read tool; blocking only one of them would leave the other open.

`secret-scan` matches whole tokens, and a prefixed token has to look like a
credential — long, with a random-looking mix of letters and digits. Ordinary
code is not a secret: `task-row`, `risk-high` and `disk-usage` are left alone,
as is an inline `data:` URI. Thresholds live in `hooks.yaml` under
`high_entropy` if your repo needs them tuned.

Glob rules: a pattern with no `/` matches a file name at any depth (`.env*`
catches `packages/app/.env.local`). A pattern with a `/` is anchored at the repo
root. `**` spans directories and `*` doesn't. Matching is case-insensitive.

A guard file that doesn't parse **stops the run**. It never falls back to
running without that guard.

---

## Running tasks safely

- Every run works on its **own git branch** (`jr-arch/session-<id>`), so you can
  review it, merge it, or throw it away. The chat reuses one branch for the
  whole conversation.
- Tasks need a repository with at least one commit, because both halves of the
  safety net are git. In a plain folder, setup (or the chat, for a folder that
  was already set up) offers to `git init` and make that first commit for you —
  with `.gitagent/.env` and `node_modules/` ignored first, so neither is ever
  committed. Decline, and it asks whether to work without git for the session;
  from the command line, `--no-git` is the same choice.
- A commit contains **only the files the attempt is answerable for**, so your
  own uncommitted work is never swept into an agent's commit, and everything
  committed has been through the secret scan.
- `run` won't start with uncommitted changes, because rolling back a failed
  attempt must never touch your own work. Commit or stash first, or pass
  `--allow-dirty`.
- A failed or handed-off agent rolls back **only the files it touched**.
- After an agent calls `done()`, the project's own build/test command runs.
  Success is committed. A red build goes to the agent that declares
  `fixes_build`, which fixes it and hands control back.
- Dependency changes and very large edits **stop and ask you before they
  happen**. In CI they're declined unless a person passes `--yes`. If you want
  the same for migrations or auth code, add a `checkpoint` guard for those
  paths; `/prompt` offers to write one.
- If a run gets stuck, `run --resume` picks it up on the same branch, with the
  record of what already failed.
- Each run leaves a transcript in `.gitagent/.session/<id>/` (gitignored), with
  keys redacted.

---

## Context between models

When one agent hands work to another, often a different model on a different
provider, the conversation can't come along. Replaying it costs more tokens
with every handoff, and one provider's message format means nothing to
another.

So jr-arch keeps a **shared record** of the work and briefs the next agent from
it:

```
## Task (unmodified)
add json config support

## Why this reached you
this needs a schema decision I cannot make

## Decisions made
- used JSON.parse directly — no schema library in the repo _(claimed, unverified)_

## Files touched
- index.js

## Approaches already ruled out — do not repeat these
- api-builder: parsed the JSON inline in index.js — failed because this needs a
  schema decision I cannot make
```

That's the whole brief: around 700 characters, not a transcript.

Look at what's marked. Anything an agent *says* is recorded as a claim; jr-arch
only records as fact what it saw happen. "Files touched" is unmarked because
the write really happened. Failed approaches can't be deleted by a later agent,
so nobody tries the same dead end twice.

Built on the approach in
[context-orchestration-engine](https://context-orchestration-engine.vercel.app/).

---

## What's in `.gitagent/`

```
.gitagent/
├── agents/
│   └── <name>/
│       ├── SOUL.md       who the agent is, what it owns (front matter)
│       ├── RULES.md      what it must and must not do
│       └── .source       where add-agent pulled it from
├── hooks/                guardrails — every .yaml here is enforced
│   ├── hooks.yaml        your own, loads last
│   └── project.yaml      written by /prompt, if it proposed guards
├── agent.yaml            model, provider, per-agent models, routing
├── DUTIES.md             the handoff protocol every agent is given
├── config/               environment settings (telemetry claim)
├── memory/               notes you keep about this repo
├── .pack.lock            what a pack installed, for `pull`
├── .session/             run transcripts and diffs — gitignored
└── .env                  your keys — gitignored, unreadable by agents
```

Everything except `.env` and `.session/` is plain text you're meant to commit,
so changes to an agent's rules can go through code review like anything else.
Type `/tree` in the chat to see your own folder with the full path to every
file.

---

## Configuration reference

### `agent.yaml`

```yaml
model:
  provider: anthropic          # see the provider table
  name: claude-sonnet-4-6
  api_key_env: ANTHROPIC_API_KEY
  base_url: null               # required for openai-compatible
  temperature: 0.2
  max_tokens: 8192

tiers:                          # optional per-agent overrides (see above)
  <agent-name>:
    model: { provider, name, api_key_env, base_url, temperature, max_tokens }

routing:
  entry: auto                  # auto, or an agent name to pin every task to it
  default_attempts: 2          # per agent, unless SOUL.md sets attempts:
  max_steps: 40                # model turns per attempt
  context_budget: 6000         # characters of compiled handoff brief
  classifier_confidence_floor: 0.6
  # degraded_fallback: <agent> # where an unclassifiable task goes (default: last by priority)

git:                            # how a run uses git
  session_branch: true         # false: work on the current branch
  branch_prefix: jr-arch
  auto_commit: true            # false: leave successful work uncommitted

source:                         # written by init --from / pull; don't hand-edit
  url: …
  ref: …
  commit: …
```

`jr-arch config set <section.key> <value>` edits one scalar and leaves the
file's comments intact.

### Environment

| Variable | Effect |
|---|---|
| the one named by `api_key_env` | the provider key. The shell wins over `.gitagent/.env` |
| `NO_COLOR` | disable ANSI colour |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No .gitagent/ found` | Run `jr-arch` (guided) or `jr-arch init` |
| `is not a git repository` / `no commits yet` | In the chat, answer yes when it offers to set up git. From the command line: `git init && git add -A && git commit -m "initial commit"`, or pass `--no-git` to accept no rollback |
| `$GROQ_API_KEY is not set` | `jr-arch key <your-key>`, or export it in your shell |
| `The working tree has N uncommitted change(s)` | Commit or stash, or pass `--allow-dirty` |
| `the model replied with prose and called no tool` | The model can't use tools. Run `jr-arch doctor`, then pick another model with `/models` |
| `hit the 40-step ceiling` | Split the task, or raise `routing.max_steps` |
| `hooks/<file>.yaml:N: …` | A guard file doesn't parse. Fix it (spaces, not tabs; no anchors or flow maps) |
| `No base_url for provider "openai-compatible"` | `jr-arch config set model.base_url <url>` |
| "the conversation alone needs N" | The input is too big, not the reply. Read less per step, or use a model with a higher limit. The loop trims automatically once `tokens_per_minute` is recorded — check `jr-arch limits` |
| Rate limit / "allows N tokens a minute" | `jr-arch limits` to see the allowance, then `jr-arch limits set default <n>` to fit under it, pick a model with higher limits (`/models`), or upgrade the plan |
| Replies are cut off mid tool call | The cap is too low: `jr-arch limits set <agent> <bigger n>` |
| Checkpoint declined in CI | Expected. A person has to pass `--yes` |
| `/check` reports an escalation loop | Mark one agent in the loop `terminal: true` |
| Agent runs unscoped / at default priority | Its `SOUL.md` front matter doesn't parse. Run `/check` |

---

## Development

```bash
git clone https://github.com/VivanRajath/content-orchestration-engine-service
cd content-orchestration-engine-service
node bin/jr-arch.js --help
npm test                      # node --test, no runner, no network
```

No dependencies to install. The architecture is in
[ARCHITECTURE.md](ARCHITECTURE.md), and the working rules, decisions and
procedures are in [RUNBOOK.md](RUNBOOK.md). Read the runbook before changing
the guardrails, the run loop, or anything that writes `agent.yaml`.

---

## Privacy

jr-arch sends nothing on its own: no telemetry, no analytics, no crash reports,
no update checks. The only network traffic goes to the AI provider you
configured, plus any `add-agent`, `add-guard`, `init --from`, or `pull` you run
yourself (a `git clone`).

## Format

The folder follows the [OpenGAP](https://www.gitagent.sh/) layout, so it stays
portable to other GAP-compatible tools. jr-arch is independent and not
affiliated with the OpenGAP maintainers.

## License

MIT
