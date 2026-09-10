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

Keys are read from an environment variable named in `agent.yaml`. They are never
written into the file, and `.gitagent/.env` is added to `.gitignore` on init.

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
| `config` | Show current model and routing |
| `config set <section.key> <value>` | Change a setting |
| `personas list` | List tiers and their roles |
| `personas add <name>` | New blank persona, or `--from <git-url>` to pull one |
| `personas remove <name>` | Delete a tier |
| `doctor` | Probe your model for the capabilities the tiers need |

## Running it

```bash
npx jr-arch init --from https://github.com/VivanRajath/gitagent-default
export ANTHROPIC_API_KEY=...
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
branch, carrying the diffs that already failed so the next tier does not
repeat them.

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

then add it to the `agents:` list in `agent.yaml` and give it an entry and
escalation conditions in `DUTIES.md`.

## Format

Files follow the [OpenGAP](https://www.gitagent.sh/) layout, so the folder stays
portable to other GAP-compatible runtimes. This CLI is an independent project and
is not affiliated with the OpenGAP maintainers.

## License

MIT
