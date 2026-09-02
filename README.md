# jr-architect

Jr Architect coding agent in your terminal.

Scaffolds a GAP-format `.gitagent/` folder into your repo, pre-filled with four
coding personas and guardrails. Point it at any model you want — your provider,
your key, your rules.

```bash
npx jr-architect init
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
npx jr-architect init --provider anthropic --model claude-sonnet-4-6
npx jr-architect init --provider openai    --model gpt-4o
npx jr-architect init --provider ollama    --model qwen2.5-coder:14b \
    --base-url http://localhost:11434/v1
npx jr-architect init --provider openai-compatible --model my-model \
    --base-url https://openrouter.ai/api/v1
```

Keys are read from an environment variable named in `agent.yaml`. They are never
written into the file, and `.gitagent/.env` is added to `.gitignore` on init.

This CLI sends nothing anywhere. No telemetry, no analytics, no crash reporting.
The only network calls are the ones you configure to your own provider, plus an
explicit `personas add --from <git-url>`.

## Commands

| Command | Does |
|---|---|
| `init` | Scaffold `.gitagent/` — `--provider`, `--model`, `--base-url`, `--minimal`, `--force` |
| `config` | Show current model and routing |
| `config set <section.key> <value>` | Change a setting |
| `personas list` | List tiers and their roles |
| `personas add <name>` | New blank persona, or `--from <git-url>` to pull one |
| `personas remove <name>` | Delete a tier |
| `doctor` | Probe your model for the capabilities the tiers need |

## Run `doctor` before you trust the tiers

The four-tier ladder assumes reliable structured output and tool calling. Many
smaller local models provide neither, and escalation then degrades into retry
thrash that looks like a bug in this tool.

`doctor` makes two real calls against your configured model and tells you whether
tiered mode will hold. If it won't, set `routing.entry` to a single tier:

```bash
jr-architect config set routing.entry senior-dev
```

Fail at setup, not mid-task.

## Guardrails

`hooks/hooks.yaml` is enforced by the harness, not by prompt text — a model that
ignores its own `RULES.md` still cannot get past it.

| Hook | Blocks | Overridable |
|---|---|---|
| `secret-scan` | diffs introducing credential-shaped strings | no |
| `protected-paths` | `.env*`, `.git/`, lockfiles, CI config | yes |
| `diff-ceiling` | oversized single edits | yes |
| `scope-fence` | `ui-editor` reaching into logic | yes |
| `build-gate` | committing a red build | yes |
| `no-force-push` | rewriting session branch history | no |

`secret-scan` and `no-force-push` are non-overridable by design. With
bring-your-own-key, the one thing a user must not be able to switch off is the
check that stops a key from getting committed.

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
jr-architect personas add reviewer
```

then add it to the `agents:` list in `agent.yaml` and give it an entry and
escalation conditions in `DUTIES.md`.

## Format

Files follow the [OpenGAP](https://www.gitagent.sh/) layout, so the folder stays
portable to other GAP-compatible runtimes. This CLI is an independent project and
is not affiliated with the OpenGAP maintainers.

## License

MIT
