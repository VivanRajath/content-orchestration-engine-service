# jr-arch

Jr Architect coding agent in your terminal.

Scaffolds a GAP-format `.gitagent/` folder into your repo, pre-filled with four
coding personas and guardrails. Point it at any model you want — your provider,
your key, your rules.

```bash
npx jr-arch init
```

## What it does

Creates `.gitagent/` in your repo root:

```
.gitagent/
├── agent.yaml              # model, provider, routing config
├── SOUL.md                 # global identity
├── RULES.md                # global constraints
├── DUTIES.md               # escalation ladder between tiers
├── agents/
│   ├── build-doctor/       # SOUL.md + RULES.md
│   ├── senior-dev/
│   ├── junior-dev/
│   └── ui-editor/
├── hooks/hooks.yaml        # guardrails
├── memory/MEMORY.md        # git-committed agent memory
└── config/default.yaml     # sandbox, git, telemetry
```

Every file is plain text in git. Edit it, diff it, branch a variant per repo,
review persona changes in a PR like any other code.

## Bring your own model

```bash
npx jr-arch init --provider anthropic --model claude-sonnet-4-6
npx jr-arch init --provider openai    --model gpt-4o
npx jr-arch init --provider ollama    --model qwen2.5-coder:14b \
    --base-url http://localhost:11434/v1
npx jr-arch init --provider openai-compatible --model my-model \
    --base-url https://openrouter.ai/api/v1
```

Any provider, any model name, any endpoint. `openai-compatible` covers anything
speaking the OpenAI API — OpenRouter, Together, Groq, vLLM, LM Studio — and you
can change all of it later without re-scaffolding:

```bash
jr-arch config set model.name qwen/qwen3-coder
jr-arch config set model.base_url https://openrouter.ai/api/v1
jr-arch config set model.api_key_env OPENROUTER_API_KEY
```

`agent.yaml` names an environment **variable**, never a key. The value comes
from your shell, or from `.gitagent/.env`:

```bash
jr-arch key sk-ant-...     # writes .gitagent/.env, 0600, gitignored
jr-arch key                # shows whether one is set, and from where
jr-arch key remove
```

### A different model per tier

The premise of a tier ladder is that tiers differ in cost and judgement, so
point them at different models. Add a `tiers:` block to `agent.yaml`:

```yaml
tiers:
  junior-dev:
    model:
      provider: openai
      name: gpt-4o-mini
      api_key_env: OPENAI_API_KEY   # jr-arch key --env OPENAI_API_KEY sk-...
  senior-dev:
    model:
      name: claude-opus-4-1         # same provider and key, bigger model
```

Anything a tier does not name is inherited, so the common case needs no block
at all. `jr-arch key` then reports every key the manifest needs and which tiers
use it, rather than just the default one.

An exported shell variable always wins over the file. The `.gitignore` rule is
verified and repaired *before* anything is written, and the agent itself cannot
read the file back — `.env*` is a sealed guardrail path, so `read_file` and
`cat` are both refused.

This CLI sends nothing anywhere. No telemetry, no analytics, no crash reporting.
The only network calls are the ones you configure to your own provider, plus an
explicit `personas add --from <git-url>`.

## Commands

| Command | Does |
|---|---|
| `init` | Scaffold `.gitagent/` — `--from <git-url>`, `--ref`, `--provider`, `--model`, `--base-url`, `--minimal`, `--force` |
| `run "<task>"` | Run the agent — `--dry-run`, `--resume`, `--allow-dirty`, `--yes`, `--no-stream` |
| `pull` | Update the installed pack, keeping your edits — `--dry-run`, `--ref`, `--force` |
| `detect` | Report the stack, verify command, and lockfile state — `--json` |
| `key [<value>]` | Store your API key, or show whether one is set — `key remove` |
| `config` | Show current model and routing |
| `config set <section.key> <value>` | Change a setting |
| `personas list` | List tiers and their roles |
| `personas add <name>` | New blank persona, or `--from <git-url>` to pull one |
| `personas remove <name>` | Delete a tier |
| `doctor` | Probe your model for the capabilities the tiers need |

## Running it

```bash
npx jr-arch init --from https://github.com/VivanRajath/gitagent-default
npx jr-arch key sk-ant-...        # or export ANTHROPIC_API_KEY yourself
npx jr-arch doctor
npx jr-arch run "add a --json flag to the status command"
```

A run works on its own branch, so it is reviewable and abandonable:

```
▸ ui-editor  attempt 1/2
    ✓ read_file  api/handler.js
    ✗ write_file  api/handler.js
    ✓ handoff  → junior-dev
! handoff → junior-dev: the fix is in the handler, not the presentation
▸ junior-dev  attempt 1/2
    ✓ write_file  api/handler.js
    ✓ done
✓ verify passed (npm run test)
  commit     867b813
```

`run` refuses to start on a dirty working tree — failed attempts are rolled
back with `git reset --hard`, and that guard is what keeps the rollback from
reaching your uncommitted work.

If a run stops and escalates to you, `run --resume` picks it up on the same
branch, carrying what already failed so the next tier does not repeat it.

## Context between models

A handoff crosses a model boundary, and often a provider boundary. Replaying
the conversation is not an option: it costs tokens quadratically in the number
of handoffs, and tool-call ids and message shapes do not survive a change of
provider. Summarising instead throws away the two things a successor most
needs — why a decision was made, and what has already been tried and failed.

So execution state is kept as a record and the successor is briefed from it:

```
## Task (unmodified)
add json config support

## Why this reached you
this needs a schema decision I cannot make

## Next action
decide on a schema shape before writing more parsing

## Decisions made
- used JSON.parse directly — no schema library in the repo _(claimed, unverified)_

## Files touched
- index.js

## Approaches already ruled out — do not repeat these
- junior-dev: parsed the JSON inline in index.js — failed because this needs a
  schema decision I cannot make
```

That is the entire brief — about 700 characters instead of a transcript.

Note what is and is not marked. A worker's output is a **claim**; the harness
records as verified only what it saw itself, so "files touched" is unmarked
because the write actually happened, while the rationale beside it is flagged
as the model's word. Failed approaches are append-only: a later tier cannot
quietly drop the earlier one's failure from the record and re-attempt it.

Budget with `routing.context_budget`. Sections trim before they drop, whatever
was cut is named in the brief, and the task itself is never trimmed.

Built on the approach in
[context-orchestration-engine](https://context-orchestration-engine.vercel.app/).

## Run `doctor` before you trust the tiers

The four-tier ladder assumes reliable structured output and tool calling. Many
smaller local models provide neither, and escalation then degrades into retry
thrash that looks like a bug in this tool.

`doctor` makes two real calls against your configured model and tells you whether
tiered mode will hold. If it won't, set `routing.entry` to a single tier:

```bash
jr-arch config set routing.entry senior-dev
```

Fail at setup, not mid-task.

## Guardrails

`hooks/hooks.yaml` is enforced by the harness, not by prompt text — a model that
ignores its own `RULES.md` still cannot get past it.

| Phase | Hook | Blocks | Overridable |
|---|---|---|---|
| edit | `secret-scan` | diffs introducing credential-shaped strings | no |
| edit | `protected-paths` | `.env*`, `.git/`, lockfiles, CI config | yes |
| edit | `diff-ceiling` | oversized single edits | yes |
| edit | `scope-fence` | `ui-editor` reaching into logic | yes |
| command | `no-force-push` | force push and history rewrites | no |
| command | `protected-read` | commands naming `.env`, `.git/`, key material | no |
| command | `no-sudo` | privilege escalation | no |
| command | `no-exfil` | `curl`/`scp`/`ssh` to a network destination | yes |
| command | `destructive` | `rm -rf`, `git clean -f`, database drops | yes |
| command | `dep-change` | routes to a human checkpoint, does not block | yes |
| commit | `build-gate` | committing a red build | yes |

`secret-scan`, `no-force-push`, `protected-read`, and `no-sudo` are sealed in
code, not merely marked non-overridable in the file they are declared in.
Editing `hooks.yaml` cannot disable them, downgrade their severity, or shorten
their lists — it can only widen them. Deleting the file entirely still leaves
them running. With bring-your-own-key, the one thing a user must not be able to
switch off is the check that stops a key from leaving the machine.

Commands run through `execFile` with `shell:false`, so `run_command` takes an
argv array and there are no shell metacharacters to smuggle a bypass through.
Gating a free-form shell string is not reliably possible; gating argv is. The
write hooks would be theatre without this — blocking edits to `.env` while
allowing `cat .env` is not a guardrail.

## Design notes

**Entry tier comes from repo state and task shape, not language or framework.**
A CSS tweak in a Go repo is still UI work.

**Build doctor never owns the feature task.** It is delegated to, fixes the build,
hands control back to the calling tier at the same step.

**Senior dev is terminal.** It escalates to the human, not to another agent.

**`ui-editor` is a peer of `junior-dev`, not below it.** The split is by domain,
not seniority, so it hands sideways.

## Customizing

Editing, not configuration. To make the junior tier bolder, raise
`junior_retry_limit` in `agent.yaml` and loosen the file ceiling in its
`RULES.md`. To add a fifth tier:

```bash
jr-arch personas add reviewer
```

That creates the persona, adds it to the `agents:` list in `agent.yaml`, and
puts a row in the `DUTIES.md` tier table. What it will not write for you is the
escalation rule — who this tier hands to, and when. That is a decision, and a
guess in the contract file is worse than a visible gap.

## Format

Files follow the [OpenGAP](https://www.gitagent.sh/) layout, so the folder stays
portable to other GAP-compatible runtimes. This CLI is an independent project and
is not affiliated with the OpenGAP maintainers.

## License

MIT
