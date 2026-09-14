# jr-arch

A coding agent that lives in your repo. Bring your own model and key — it edits
your code under guardrails you control, and nothing leaves your machine except
calls to the AI provider you choose.

```bash
npx jr-arch
```

That's the whole install. It asks you what it needs, one step at a time.

## What happens when you run it

```
  Step 1 of 4  Connect an AI provider
  API key: ✓ That looks like a Groq key gsk_… (56 chars)
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

Your key is **checked by listing the models it can reach** — so a wrong key is
caught here, not as an error on your first task, and you only ever pick from
models your key can actually use. The key is hidden as you type it.

## Three ways to work

Once you're set up, `jr-arch` opens a chat. Switch modes any time.

### `/prompt` — describe it, get agents

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

Then it asks which model each agent should use — and whether any of them should
run on a **different provider with its own key**. A cheap, fast model for scoped
work and a stronger one for decisions is exactly what this is for.

You always see the plan before anything is written. The model proposes; jr-arch
validates every field and writes the files itself, so a bad generation cannot
sneak in an escalation loop, a guardrail that switches something off, or a model
choice you didn't make.

### `/dev` — write your own

```
  /new reviewer      scaffold an agent: SOUL.md + RULES.md
  /guard strict      scaffold a guard file
  /edit reviewer     show where its files are
  /check             find problems before a run does
  /smoke reviewer    check it actually works
  @reviewer <task>   give it a task
```

`/check` catches the mistakes that would otherwise fail silently mid-run: an
agent escalating to one that isn't installed, two agents handing a task back and
forth forever, a guard still full of `TODO`s that protects nothing.

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

The last check sends the agent's real prompt and asks it to call a tool. Nothing
is written, so it's safe on any repo. A model that answers in prose instead of
calling tools can't drive an agent — better to learn that now.

### `/chat` — just give it tasks

```
  [chat] › add a --json flag to the status command
  api-builder · single-concern change to one route
    ✓ read_file   src/routes/status.js
    ✓ write_file  src/routes/status.js
    ✓ done
  ✓ verify passed (npm run test)
    commit  867b813
```

Type a task and the right agent picks it up, or send it to one with `@name`.

## Bring your own model

| Provider | Key looks like | |
|---|---|---|
| Anthropic | `sk-ant-…` | |
| Groq | `gsk_…` | |
| OpenAI | `sk-…` | |
| OpenRouter | `sk-or-…` | |
| xAI | `xai-…` | |
| Ollama | — | type `ollama` instead of a key; runs locally |
| Anything OpenAI-compatible | — | Together, vLLM, LM Studio… you give the URL |

Paste a key and the provider is recognised from its format. Change it any time:

```
  /key       add or change a key
  /models    switch model
```

or from outside the chat:

```bash
jr-arch key gsk_...                      # store a key
jr-arch key                              # which keys are set, and from where
jr-arch config set model.name qwen/qwen3-32b
```

**Where your key lives.** `agent.yaml` names an environment *variable*, never a
key. The value goes in `.gitagent/.env`, which is gitignored before anything is
written to it. A key you export in your shell always wins over the file. And the
agents themselves can't read it — `.env*` is a sealed guardrail path, so both
`read_file` and `cat` are refused.

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

`/prompt` writes this for you. Anything an agent doesn't set is inherited.

## Context between models

When one agent hands work to another — often a different model on a different
provider — the conversation can't come with it. Replaying it costs tokens that
grow with every handoff, and one provider's message format means nothing to
another.

So jr-arch keeps a **shared record** of the work and briefs the next agent from
that:

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

That's the whole brief — around 700 characters, not a transcript.

Notice what's marked. What an agent *says* is a claim; jr-arch only records as
fact what it saw happen. "Files touched" is unmarked because the write really
occurred. And failed approaches can't be deleted by a later agent, so nobody
tries the same dead end twice.

Built on the approach in
[context-orchestration-engine](https://context-orchestration-engine.vercel.app/).

## Agents

An agent is a folder with a `SOUL.md` (who it is) and a `RULES.md` (what it must
and must not do). It describes itself in front matter:

```yaml
---
name: reviewer
role: Reviews diffs before they land
priority: 20              # lower numbers claim work first
owns: ["**/*.test.js"]    # files it claims; [] means anything
parallel: true            # may run beside agents with non-overlapping scope
escalates_to: lead        # who takes over when it runs out of attempts
terminal: true            # or: stop and ask you instead
fixes_build: true         # a red build comes here first
attempts: 2
---
```

The folder *is* the install — create one and the agent exists, delete it and
it's gone. There's no list to keep in sync.

jr-arch ships four starter agents, but they're a default, not the product.
Replace them with `/prompt`, write your own with `/dev`, or pull one from GitHub:

```bash
jr-arch add-agent https://github.com/you/my-reviewer
jr-arch add-guard https://github.com/you/strict-guards
```

**One thing an agent can't choose is its model or key.** Agents can be pulled
from any URL, and one deciding where your code gets sent would defeat the point.
Model choice stays in your own `agent.yaml`.

### Swarms

Agents that opt in with `parallel: true` and have **non-overlapping** `owns` can
run at the same time on one task:

```bash
jr-arch run "update the api and its tests" --swarm
```

They share the same context record. If one fails, only *its* files are rolled
back — the others' work stays.

## Guardrails

Guardrails are enforced by jr-arch itself, not by asking the model nicely. A
model that ignores its own `RULES.md` still can't get past them.

| When | Guard | Stops | Can be turned off |
|---|---|---|---|
| edit | `secret-scan` | code introducing API keys or private keys | **no** |
| edit | `protected-paths` | `.env*`, `.git/`, lockfiles, CI config | yes |
| edit | `diff-ceiling` | huge single edits (asks you) | yes |
| edit | `scope-fence` | an agent editing outside its lane | yes |
| command | `no-force-push` | force pushes and history rewrites | **no** |
| command | `protected-read` | reading `.env`, `.git/`, key files | **no** |
| command | `no-sudo` | privilege escalation | **no** |
| command | `no-exfil` | `curl`/`scp`/`ssh` sending data out | yes |
| command | `destructive` | `rm -rf`, `git clean -f`, dropping databases | yes |
| command | `dep-change` | dependency changes (asks you) | yes |
| commit | `build-gate` | committing a failing build | yes |

The four marked **no** are sealed in code. No guard file — yours, a pulled one,
or a generated one — can disable them, weaken them, or shorten their lists.

### Writing your own

Every YAML file in `.gitagent/hooks/` is loaded, and a guard is enforced by
what it declares — name it anything:

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

An edit guard stops changes but still lets agents *read* the file — they usually
need to understand code they aren't allowed to touch. To stop reading as well,
put the path in a `pre_command` guard: that covers both `cat` and the agent's
read tool, since blocking one and not the other would just move the leak.

## Running tasks safely

- Every run works on its **own git branch**, so you can review it, merge it, or
  throw it away.
- `run` won't start with uncommitted changes, because a failed attempt is rolled
  back and that must never reach your work. Commit or stash first.
- A failed agent rolls back **only the files it touched**.
- Dependency changes and very large edits **stop and ask you** — even in
  automation, unless a person passes `--yes`. Want the same for migrations or
  auth code? Add a `checkpoint` guard for those paths; `/prompt` offers to write
  one. (The default agents' rules also *tell* them to ask first, but a rule is
  a request — only a guard is enforced.)
- If a run gets stuck, `run --resume` picks it up on the same branch, knowing
  what already failed.

## Commands

| Command | |
|---|---|
| `jr-arch` | Guided setup on first run, then the chat |
| `jr-arch run "<task>"` | One task, no chat — `--agent`, `--swarm`, `--dry-run`, `--resume`, `--yes` |
| `jr-arch smoke [agent]` | Check an agent works — `--offline` skips the model call |
| `jr-arch add-agent <url>` | Install an agent from a git repo |
| `jr-arch add-guard <url>` | Install a guard file from a git repo |
| `jr-arch agents` | List installed agents |
| `jr-arch key [<value>]` | Store a key, or show which are set — `--env <NAME>`, `remove` |
| `jr-arch config` | Show model and routing — `config set <section.key> <value>` |
| `jr-arch init` | Scaffold without the guided setup — `--provider`, `--model`, `--from <url>` |
| `jr-arch detect` | Report the stack, test command, and lockfile |
| `jr-arch pull` | Update an installed pack, keeping your edits |
| `jr-arch doctor` | Check your model supports tool calling |

## What's in `.gitagent/`

```
.gitagent/
├── agents/
│   └── <name>/
│       ├── SOUL.md       who the agent is, what it owns
│       └── RULES.md      what it must and must not do
├── hooks/                guardrails — every .yaml here is enforced
├── agent.yaml            model, provider, per-agent models
├── DUTIES.md             how agents hand work to each other
├── config/               sandbox and git settings
├── memory/               what agents learn about this repo
└── .env                  your keys — gitignored, unreadable by agents
```

Everything except `.env` is plain text meant to be committed. Review a change to
an agent's rules in a pull request like any other code. Type `/tree` in the chat
to see your own, with the full path to every file.

## Privacy

jr-arch sends nothing anywhere on its own — no telemetry, no analytics, no crash
reports, no update checks. The only network traffic is to the AI provider you
configured, plus any `add-agent`, `add-guard`, or `init --from` you run yourself.

## Format

The folder follows the [OpenGAP](https://www.gitagent.sh/) layout, so it stays
portable to other GAP-compatible tools. jr-arch is independent and not affiliated
with the OpenGAP maintainers.

## License

MIT
