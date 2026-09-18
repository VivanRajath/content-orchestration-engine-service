# jr-arch runbook

The working manual for people changing this codebase. It covers how to set up
and debug, how to make each common kind of change without breaking an
invariant, why the important decisions were made (and where the code enforces
them), what changed over time, and what is currently wrong or incomplete.

- Using the CLI: [README.md](README.md)
- How it fits together: [ARCHITECTURE.md](ARCHITECTURE.md)
- Agent-facing project notes: [CLAUDE.md](CLAUDE.md)

This file is current as of **0.1.3** (24 commits plus uncommitted work, 564 passing tests).

---

## Contents

1. [Non-negotiables](#1-non-negotiables)
2. [Environment and daily commands](#2-environment-and-daily-commands)
3. [Reading order for a newcomer](#3-reading-order-for-a-newcomer)
4. [Debugging a run](#4-debugging-a-run)
5. [Procedures](#5-procedures)
6. [Decisions log](#6-decisions-log)
7. [Gotchas](#7-gotchas)
8. [Change history](#8-change-history)
9. [Known gaps and drift](#9-known-gaps-and-drift)
10. [Roadmap](#10-roadmap)
11. [Maintainer troubleshooting](#11-maintainer-troubleshooting)
12. [Glossary](#12-glossary)

---

## 1. Non-negotiables

Check a change against this list before opening a PR. Each item has a
decision-log entry in [§6](#6-decisions-log) that explains why.

- [ ] **Zero runtime dependencies.** No new entries under `dependencies`. No
      argv-parsing library, no YAML library.
- [ ] **No telemetry.** The CLI never initiates network traffic other than the
      user's provider and an explicit `git clone`. No version checks, no crash
      reporting.
- [ ] **No default agent name in executable routing code.** `build-doctor`,
      `junior-dev`, `senior-dev` and `ui-editor` exist only in `templates/`.
      `test/custom-agents.test.js` must keep passing.
- [ ] **No global SOUL.md / RULES.md.** `prompt()` in `run.js` injects
      mechanics only.
- [ ] **No `agents:` list as a source of truth.** The directory is the registry.
- [ ] **Guardrails are enforced in `hooks.js`, not in prompts.** Any new safety
      property belongs in a hook.
- [ ] **Sealed hooks can only be widened.** `secret-scan`, `no-force-push`,
      `protected-read` and `no-sudo`.
- [ ] **A blocked hook returns a tool error.** It never throws out of the loop.
- [ ] **Checkpoints are asked before the action,** default to "no" when nobody
      can answer, and a "no" is a tool error.
- [ ] **Keys never go in `agent.yaml`,** never reach the screen in full, never go
      to a provider they don't belong to, and the model can never read them.
- [ ] **`.gitignore` is ensured before any key is written.**
- [ ] **The shell environment wins over `.gitagent/.env`.**
- [ ] **Rollback only touches the attempt's own files,** and a commit contains
      only those files — staged with a pathspec, gated on the same set.
- [ ] **A run needs a repository with a commit,** or explicit `--no-git`:
      without one there is no branch and no rollback.
- [ ] **Sealed hooks must not fire on ordinary code.** A false positive in a
      hook nobody can disable makes a repository unusable.
- [ ] **Model calls may run in parallel; git bookkeeping may not.**
- [ ] **Chat goes through `run()`.** There is no second execution path.
- [ ] **One readline interface per process.** Pass the prompter down.
- [ ] **Model-authored config is never written verbatim.** Validate, then build
      from the validated values.
- [ ] **A pack may not declare a model, provider, key env or base URL.**
- [ ] **`agent.yaml` writes are line-based and section-scoped.** Never
      round-trip it through the parser.
- [ ] **The YAML parser throws on anything it doesn't understand.**
- [ ] **The version lives only in `package.json`.**
- [ ] **Every new valueless flag goes in `BOOLEAN`.**
- [ ] **Every interactive flow takes a prompter** and has a `scriptedPrompter`
      test.

---

## 2. Environment and daily commands

### Requirements

- Node **≥ 18** (`engines`). Development has been on Node 24; `prompter.js`
  relies on readline internals that were verified there.
- git on `PATH`.
- Windows, macOS and Linux are all targets. The author works on Windows, and
  several code paths exist only for it (`resolveBin`, Ctrl+V clipboard).

### Commands

```bash
npm test                                   # node --test — all 564, ~50s
node --test test/hooks.test.js             # one file
node --test --test-name-pattern "sealed"   # by name
node bin/jr-arch.js --help                 # run from source
node bin/jr-arch.js --version              # reads package.json
npm link                                   # put jr-arch / jra on PATH from this checkout
```

There's no build step, linter or formatter. Match the surrounding style: ESM,
2-space indent, single quotes, semicolons, and block comments explaining *why*.

### A throwaway repo to try changes in

```bash
mkdir /tmp/jra-play && cd /tmp/jra-play
git init && echo '{"scripts":{"test":"node -e 0"}}' > package.json
git add -A && git commit -m init
node /path/to/jr-cli/bin/jr-arch.js init --provider groq --model llama-3.3-70b-versatile
node /path/to/jr-cli/bin/jr-arch.js key gsk_...
node /path/to/jr-cli/bin/jr-arch.js smoke --offline
node /path/to/jr-cli/bin/jr-arch.js run "add a README" --dry-run
```

On Windows, use `%TEMP%` or the scratch directory rather than `/tmp`.

### Driving a real console

Plain piped stdin puts readline in **non-terminal mode**, which is a different
code path, and every keyboard bug users hit was in the terminal path. To
exercise that path:

- **Automated:** `test/terminal.test.js` builds a fake TTY. Extend it for any
  prompter change.
- **Manual on Windows:** `winpty -Xallow-non-tty -Xplain node bin/jr-arch.js`,
  sending Enter as `\r`.
- **Manual elsewhere:** run it in a real terminal. Don't pipe input.

---

## 3. Reading order for a newcomer

Read these in order. Each builds on the one before.

1. `CLAUDE.md`: the decisions, in the author's words.
2. `bin/jr-arch.js`: every entry point, in about 150 lines.
3. `templates/`: what a user actually gets: `agent.yaml`, `DUTIES.md`,
   `hooks/hooks.yaml`, one `agents/*/SOUL.md`.
4. `src/agents.js`: how an agent is described and routed.
5. `src/hooks.js`: the safety model. Read `SEALED`, `seal()`, then `checkEdit`
   and `checkCommand`.
6. `src/tools.js`: the only surface the model can reach.
7. `src/run.js`: `run()` → `ladder()` → `attempt()`; then `swarm()`.
8. `src/session.js`: branches, frames, revert, commit.
9. `src/context.js`: the ledger and `compile()`.
10. `src/provider.js`: `callModel()` and `request()`.
11. `src/chat.js` → `src/onboard.js` → `src/generate.js`: the front door.
12. `src/pack.js` → `src/pull.js`: distribution.

---

## 4. Debugging a run

### Where the evidence is

Every run (except `--dry-run`) creates `.gitagent/.session/<id>/`:

| File | Contents |
|---|---|
| `task.md` | the task as given |
| `transcript.jsonl` | one JSON event per line, keys redacted |
| `attempt-<n>.diff` | the diff of each attempt, scoped to its own paths |
| `summary.md` | final status, branch, agent path, summary |

Session ids sort chronologically, so the newest is last in `ls`.

### Transcript events

| event | fields |
|---|---|
| `session.open` | `id`, `branch`, `from`, `sha` |
| `attempt.open` | `n`, `tier`, `parent` (fixer nesting), `reason` |
| `tool` | `tool`, `tier`, `path`, `command`, `isError` |
| `attempt.close` | `n`, `tier`, `status`, `reason`, `steps`, `green`, `diffLines` |
| `attempt.revert` | `n`, `tier`, `to`, `restored`, `deleted` |
| `attempt.commit` | `n`, `tier`, `sha` |
| `ledger` | `tier`, `status`, counts of decisions / failed / artifacts |
| `session.close` | `status`, `attempts` |

```bash
S=.gitagent/.session/$(ls .gitagent/.session | tail -1)
cat $S/summary.md
# what did each attempt do, and how did it end?
grep -E '"attempt\.(open|close)"' $S/transcript.jsonl
# which tool calls were blocked or errored?
grep '"isError":true' $S/transcript.jsonl
```

The transcript does **not** contain model text or tool results. It records
what happened, not what was said. To see model output, run in a TTY (it
streams), or use `--no-stream` and read the dimmed lines.

### Failure signatures

| Output | Where it comes from | Usual cause |
|---|---|---|
| `the model replied with prose and called no tool` | `attempt()`, step 1 | the model can't call tools; `doctor` / `smoke` will confirm |
| `stopped acting — 3 replies in a row with no tool call` | `attempt()`, `IDLE_LIMIT` | a weak model drifting |
| `hit the 40-step ceiling` | `attempt()` | a loop on a failing test, or a task that's too large |
| `model call failed: …` | provider error, already described | a limit, the key, the model name |
| `handoff → X: …` then a retry | the model called `handoff` | expected behaviour |
| `X exhausted N attempts → Y` | ladder budget | expected; check the reasons in the transcript |
| `X escalates to Y, which already used its attempts — stopping` | ladder guard | an escalation cycle; `/check` reports it |
| `commit blocked by …` | `checkCommit` | red build, a secret, or a protected path in touched files |
| `checkpoint — dep-change: … not a terminal, and --yes was not passed — declining` | `ask()` | expected in CI |
| `hooks/<f>.yaml:N: …` at start | `loadHooks` → `parseYaml` | a guard file that doesn't parse (tabs, anchors, flow maps) |
| `routing.entry is "X", which is not in the agents list` | `classify()` | pinned entry names an uninstalled agent |
| `No DUTIES.md in …` | `classify()` → `readDuties` | DUTIES.md deleted (see [§9](#9-known-gaps-and-drift)) |
| `classifier did not return usable JSON; using routing.degraded_fallback` | `classify()` | a weak model; pin `routing.entry` |
| `refusing to run "…" through cmd.exe` | `winCmd` | a Windows shim token containing a metacharacter |

### Reproducing a model bug without a key

Everything that calls a model accepts an injected `call`. Write a scripted
model that returns `{text, toolCalls, stopReason}` in sequence. `test/run.test.js`
and `test/swarm.test.js` show the pattern. For provider wire bugs, feed recorded
SSE bytes to `parseSSE` + `readAnthropicStream` / `readOpenAIStream`
(`test/stream.test.js`), or a status, body and headers to `parseProviderError`
(`test/limits.test.js`).

---

## 5. Procedures

### 5.1 Add a CLI command

1. Create `src/<name>.js` exporting `async function <name>(positional, flags)`.
2. Import it in `bin/jr-arch.js` and add a `case` to the switch.
3. Add it to `HELP` in `bin/jr-arch.js`, to the README Commands table, and to
   the ARCHITECTURE module table.
4. Throw `Error`s with actionable messages. `bin/` prints `✗ message` and exits
   1. Set `process.exitCode = 1` for a soft failure (see `smoke`).
5. If it asks questions, take a prompter (see 5.8). If it talks to a model,
   take `call`. If it fetches, take `fetchImpl`.
6. Add `test/<name>.test.js`.

### 5.2 Add a flag

1. If it takes **no value**, add it to `BOOLEAN` in `bin/jr-arch.js`.
   Otherwise `--flag "task"` swallows the task.
2. Read it as `flags['kebab-name']`. A value flag can also be `true` when given
   without a value, so check `typeof flags.x === 'string'` (see `--agent`,
   `--ref`).
3. Document it in `HELP` and in the README Flags table.
4. If the chat should forward it, note that `chat.js` spreads `...flags` into
   `run()`.

### 5.3 Add a provider

1. Add an entry to `PROVIDERS` in `src/providers.js`: `label`, `wire`
   (`anthropic` | `openai`), `base`, `keyEnv`, `keyPattern`, `signup`, and
   `noKey` if it needs no key.
2. If it has a key prefix, insert it in `DETECT_ORDER` **before** any provider
   whose prefix is a prefix of it (`sk-` must stay after `sk-ant-` and `sk-or-`).
3. If `/models` returns non-chat models with unfamiliar names, extend
   `isChatModel`.
4. If the wire format differs from both existing ones, add converters in
   `provider.js` and a stream reader. Keep the provider-neutral transcript shape
   unchanged.
5. Add it to the `obtainKey` menu in `onboard.js` if it should be offered when a
   key's prefix isn't recognised.
6. Update `--provider` in `HELP`, the provider table in the README, and
   ARCHITECTURE §15.
7. Tests: `detectProvider`, `baseUrlFor`, and `listModels` with a fake
   `fetchImpl` in `test/providers.test.js`.

**Never** add a fallback URL. If a provider has no base URL, the request must
refuse rather than guess.

### 5.4 Add a tool

This is the most dangerous change in the codebase. The tool list is the model's
entire reach.

1. Add a schema to `TOOLS` and a handler to `HANDLERS` in `src/tools.js`.
2. Handlers return `ok(content)` / `err(content)`, plus `control` only for
   loop-ending tools. They must never throw on bad input; return `err`.
3. Confine every path with `inside(ctx.root, path)`.
4. Gate it through `hooks.js`. If the existing checks don't fit, add a new check
   function there, not inline in the handler.
5. Call `approved(gate, ctx)` **before** any side effect.
6. Record touched files in `ctx.touched` so revert, diff and commit see them.
7. Mention it in `prompt()`'s "How you operate" section if the model needs to
   know how to use it.
8. Tests in `test/tools.test.js`: path escape, block, checkpoint declined
   (nothing happened), checkpoint approved.

### 5.5 Add or change a hook

**A new built-in hook with dedicated logic:**

1. Add the logic in the relevant `check*` function in `src/hooks.js`.
2. Add its name to `BUILTIN_EDIT` or `BUILTIN_COMMAND`, so the shape
   enforcement below doesn't also run on it.
3. Declare it in `templates/hooks/hooks.yaml` with a `description`.
4. Write block reasons **as instructions to the agent**: what was stopped, and
   what to do instead.
5. Update the README guardrail table.

**A new sealed hook** (rare; needs a decision-log entry):

1. Add it to `SEALED` and `SEALED_FLOOR`.
2. Its lists must be the minimum set that can never produce a false positive,
   because nobody can switch a sealed hook off.
3. Test that `enabled: false`, a severity change, `overridable: true`, and a
   shortened list are all ignored and each produces a note.

**Changing shape enforcement** (`enforce`, `others`, `appliesTo`): add a case to
`test/regressions.test.js`. A custom-named hook that loads but is never
evaluated is the exact regression that file exists for.

### 5.6 Add a key to `agent.yaml`

1. **Read** it only through `readManifest()` in `src/config.js`. Add a
   normalised field, or read `manifest.raw.<section>.<key>` with a default.
2. Put it in `templates/agent.yaml` with an explanatory comment. The comments
   are documentation.
3. **Write** it only with `patchSection` (a scalar), or `upsertSection` (a whole
   block), scoped to its section. Never use a file-wide regex, and never
   serialise the parsed document.
4. If it's per-agent model configuration, extend `modelFor()` and keep its
   return shape identical to `readManifest()`'s.
5. If a pack may suggest it, check `rewriteManifest` / `init`: only keys that
   already exist are patched.
6. Update the README configuration reference.

### 5.7 Add an agent front-matter field

The field has to be threaded through every place that reads or writes front
matter:

| Place | What to do |
|---|---|
| `src/agents.js` `readAgents()` | parse and default it |
| `src/generate.js` `PLAN_SYSTEM`, `validatePlan()`, `soulFile()` | describe it, validate/clamp it, write it |
| `src/dev.js` `agentTemplate()`, `checkAll()` | scaffold it commented, validate it |
| `src/personas.js` `BLANK_SOUL` | scaffold it |
| `src/smoke.js` | check it if it can be wrong at runtime |
| `templates/DUTIES.md` example, `templates/agents/*/SOUL.md` | as appropriate |
| README "Agents" block, ARCHITECTURE §4 | document |

Single-line string fields must go through `line()` in `generate.js`. Remember
that the field must never describe a model, provider or key.

### 5.8 Add an interactive question

1. Take a `prompter` parameter. Never call `createPrompter()` inside a flow that
   can be reached from the chat.
2. `choose` options that are **only sometimes present go last**, so the
   numbering of the others never changes.
3. Treat a `null` answer (Ctrl-D, or closed) as cancel.
4. Write a `scriptedPrompter` test with exactly the expected answers. It throws
   if the flow asks one more question.
5. If the change touches `prompter.js` itself, add a terminal-mode case in
   `test/terminal.test.js`.
6. Non-TTY: the flow must explain what to run instead, not hang (see
   `chat.js` `needsSetup`).

### 5.9 Add a template file

`init` copies `templates/` wholesale, so a new file ships automatically. Then:

- Add it to `MINIMAL` in `src/init.js` if `--minimal` should include it.
- Give it a note in `NOTES` in `src/tree.js` if `/tree` should explain it.
- With `init --from <pack>`, only `agent.yaml`, `config/` and `memory/` come
  from `templates/`. Everything else comes from the pack, so a new template
  file won't appear in pack installs.

### 5.10 Change the run loop

Before changing `run.js` or `session.js`, go through this list:

- Does the attempt still revert **only** `attemptPaths(frame)`?
- Does git still run **outside** `checkCommand`?
- In a swarm, is every git operation inside `gitLock`?
- Is `frame.touched` still shared with `toolCtx.touched`?
- Can a handoff or failure still produce a ledger entry via `record()` (the
  report call is optional, the observed half is not)?
- Is `task` still pinned in `compile()`?
- Does the chat (`quiet`, `allow-dirty`, `prompter`) still go through the same
  path?
- Run `test/run.test.js`, `test/tiers.test.js`, `test/swarm.test.js`,
  `test/custom-agents.test.js` and `test/context.test.js`.

### 5.11 Release

1. Make sure the working tree is clean and on `main`.
2. Bump the version **only** in `package.json`. `--version` reads it at runtime.
3. `npm test`. `prepublishOnly` runs it again and blocks a publish on failure.
4. `npm pack --dry-run` and check the tarball contains only `bin/`, `src/`,
   `templates/`, `README.md`, `LICENSE` and `package.json`. (`ARCHITECTURE.md`
   and `RUNBOOK.md` are not in `files` and aren't shipped. Add them if you want
   them on npm.)
5. `npm publish`.
6. `git tag v<version> && git push --tags`.
7. Check with `npx jr-arch@<version> --version` in an empty directory.
8. Update "Status" and "Next" in `CLAUDE.md`, and the version at the top of
   this runbook and ARCHITECTURE.md.

### 5.12 First real-model test (roadmap item 1)

The loop has only been exercised by scripted models. When someone first has a
key:

1. Use a throwaway repo (see §2) with a real test script.
2. `jr-arch doctor`, then `jr-arch smoke`. Both must pass.
3. Run a trivially scoped task: `jr-arch run "add a hello() export to index.js"`.
4. Run a task that must escalate: pin `--agent junior-dev` on something
   cross-cutting.
5. Run a task that breaks the build, to exercise the `fixes_build` nesting.
6. Run a task that tries `npm install left-pad` without `--yes`, and confirm
   the checkpoint is asked *before* the install.
7. Try `--swarm` with two scoped parallel agents.
8. Try `/prompt` end to end.
9. For each run, read `transcript.jsonl`, the diffs and `summary.md`. Record
   what happened in `CLAUDE.md` Status, and add a test for anything that broke.

---

## 6. Decisions log

Each decision is listed with the reason for it, where the code enforces it, and
which test pins it. Reverse one only with a new entry here that explains why.

### 6.1 Product and distribution

| Decision | Why | Enforced in | Pinned by |
|---|---|---|---|
| **Zero runtime dependencies**, hand-rolled argv parsing | `npx` speed is a feature; "audit it yourself" loses credibility with a transitive dependency tree | `package.json`, `bin/jr-arch.js` | — |
| **No telemetry, ever** | The privacy claim is the product. `config/default.yaml` states `telemetry: enabled: false` so users can check it | absence of network code outside `provider.js`, `providers.js`, `pack.js` | — |
| **The four tiers are a default pack, not the product** | Users install arbitrary agents; nothing may assume a set, count or ladder. Zero agents is an error, never a fallback | `readAgents()`, `run()` zero-agent throw | `custom-agents.test.js` |
| **No default agent name in executable code** | Every routing decision is declared by the agent itself | `agents.js`, `classify.js`, `run.js` | `custom-agents.test.js` (agents named medic / scout / archivist) |
| **An agent describes itself** (front matter) | Installing is copying a folder; no registry to keep in sync | `readAgents()` | `agents.test.js` |
| **No `agents:` list in `agent.yaml`** | A manifest list is a second source of truth, and it drifted once the loop started reading the directory | `readAgents()`; `init`/`pull` no longer write it | `pack.test.js` |
| **No global SOUL.md / RULES.md** | The harness shouldn't co-author agents it didn't write, or override a pulled agent's own identity | `prompt()` in `run.js` | `run.test.js` |
| **DUTIES.md names no agent** | It's the protocol; agents declare their own place in it | `templates/DUTIES.md` | — |
| **`jr-arch` with no arguments is the chat** | The front door. Chat is a way into `run()`, never a second execution path | `chat.js` `turn()` | `phase1.test.js` |
| **Setup doesn't ask questions nobody can answer** | No TTY → explain what to run; every flow takes a prompter | `chat.js` `needsSetup` | `phase1.test.js` |
| **Built on the OpenGAP layout** | Portability to other GAP runtimes | `templates/` | — |

### 6.2 Guardrails

| Decision | Why | Enforced in | Pinned by |
|---|---|---|---|
| **Guardrails belong in `hooks/`, not RULES.md** | Users bring weak models that ignore their rules; anything that matters must block at the harness | `hooks.js`, `tools.js` | `hooks.test.js` |
| **Four hooks are sealed in code** | A guardrail you can disable by editing its own file isn't a guardrail | `SEALED`, `seal()` | `hooks.test.js` |
| **Sealed lists can only be widened** | Packs and generated files may tighten, never loosen | `seal()` → `union` | `hooks.test.js`, `pack.test.js` |
| **`protected-read` is narrower than `protected-paths`** | It's sealed, so a false positive can never be switched off; `node_modules/.bin/jest` must stay runnable | `SEALED_FLOOR` | `hooks.test.js` |
| **A guard is enforced by what it declares, not by its name** | Custom-named hooks from `add-guard` / `/prompt` used to load, report success, and never run. A guardrail that silently does nothing is worse than none, because people rely on it | `others()`, `enforce()` | `regressions.test.js` |
| **A command guard naming a path also covers `read_file`**; an edit guard doesn't | Blocking `cat x` but not `read_file(x)` would leave the leak open through the other tool; agents need to read code they may not change | `checkRead()` | `hooks.test.js`, `tools.test.js` |
| **Guards are additive; `hooks.yaml` loads last** | `add-guard` extends; the repo's own file wins conflicts | `hookFiles()` | — (no load-order test) |
| **Fail closed on a guard file that doesn't parse** | An unparseable guard must abort, not degrade to unguarded | `loadHooks()` | `hooks.test.js` |
| **A blocked hook is a tool error, never an exception** | Block reasons are instructions; a model that's told why can correct, a killed run can't | `dispatch()`, `blocked()` | `tools.test.js` |
| **Commands are argv with `shell: false`** | Analysing argv is reliable; every bypass lives in shell metacharacters | `run_command`, `checkCommand` | `tools.test.js` |
| **A prefix match must look like a credential** (whole token, length, mixed body, entropy) | `indexOf('sk-')` over a whole line refused `task-row`, `risk-high`, `disk-usage` — in a sealed hook, at edit time and again over whole files at commit time. A sealed guard that fires on ordinary code is not strict, it is broken | `looksLikeCredential()` | `hooks.test.js` |
| **An inline `data:` URI skips the entropy rule** | Embedded images are high-entropy by nature and carry nothing secret | `scanLines()` | `hooks.test.js` |
| **Secret scan covers added lines only (multiset delta)** | Scanning whole files would permanently block edits to any file with a fixture-shaped string | `lineDelta()` | `hooks.test.js` |
| **`ignore_paths` skips entropy only; universal globs refused** | Lockfile hashes are noisy but not trusted; `**` would disable the check | `seal()`, `scanLines()` | `hooks.test.js` |
| **Candidate secrets are masked in reasons** | Reasons land in transcripts and on screen | `mask()` | — |
| **Bare `npm install` isn't a dep-change** | It restores from the lockfile; the build fixer needs it | `depChangeReason()` | `hooks.test.js` |
| **Unknown build state is not a pass, but doesn't block a commit** | Otherwise repos without a test command could never commit | `checkCommit()` | `hooks.test.js` |

### 6.3 Human checkpoints

| Decision | Why | Enforced in | Pinned by |
|---|---|---|---|
| **A checkpoint is asked before the action** | It used to be asked after `npm install` had already run | `tools.js` `approved()` | `tools.test.js` |
| **"No" is a tool error, remembered for the attempt** | The model takes another approach; the human isn't asked the same question repeatedly | `toolCtx.approve` in `attempt()` | — (the tool-level decline is in `tools.test.js`; the per-attempt memory isn't tested) |
| **Non-interactive declines; `--yes` must be typed by a person** | A dependency change waved through because the run happened to be in CI is what the checkpoint list exists to prevent | `ask()`, `approved()` | `tools.test.js` (no approver → declined); `ask()` itself untested |
| **Chat doesn't pass `--yes`** | Chat is a faster way into the loop, not a way around it | `chat.js` `turn()` | — |
| **Swarm prompts queue on `askLock`** | Two concurrent "Allow?" prompts would interleave | `checkpoint()` | — |
| **A diff over the ceiling is a checkpoint, not a block** | DUTIES.md makes an oversized edit a human decision | `checkEdit` diff-ceiling | `hooks.test.js` |

### 6.4 Execution, git and rollback

| Decision | Why | Enforced in | Pinned by |
|---|---|---|---|
| **`run` refuses a dirty tree** (`--allow-dirty` to override) | Rollback must only be able to destroy the agent's own work | `run()` | `run.test.js` |
| **A failed agent rolls back its own files and nothing else** | A whole-tree reset would take a sibling's success in a swarm, or an earlier uncommitted chat turn | `revertAttempt()`, `attemptPaths()` | `swarm.test.js`, `run.test.js` |
| **Scope widens rollback to dirty files it owns; no scope → only explicit writes** | A formatter run via `run_command` is still caught; "everything dirty" would sweep up others' work | `attemptPaths()` | `swarm.test.js` |
| **Handoffs revert too** | Half an attempt left in the tree is a trap for the next agent, not a starting point | `ladder()` | `run.test.js` |
| **A commit stages a pathspec of the attempt's own paths** | `git add --all` committed a sibling's files and the user's uncommitted work under this agent's name, unscanned, because the gate only saw `write_file` paths | `commitAttempt()`, `commit()` | `production-fixes.test.js` |
| **The chat offers to create a repository; it never creates one unasked** | A repository in someone's folder is theirs to decide, but the decision should be one keystroke rather than a command to go and find. Only an interactive session asks: a prompter reading a closed stdin would take the default, and the default is yes | `ensureRepo()`, `initialCommit()` | `production-fixes.test.js` |
| **The first commit ignores the key and `node_modules` before staging** | Any folder where someone ran `npm i jr-arch` has a `node_modules/`, and `.gitagent/.env` holds their key | `initialCommit()` | `production-fixes.test.js` |
| **A run refuses a repo with no commits** (`--no-git` to override) | Without a commit `openSession` cannot branch and `revertAttempt` has no sha, so it returns silently — no branch, no rollback, no warning. The chat reaches it by default via `--allow-dirty` | `requireGit()` | `production-fixes.test.js` |
| **A swarm's commits are gated on the post-swarm build** | Frames closed with no verify result, and "unknown" only warns, so a red build was committed | `swarm()` + `run()` | `swarm.test.js` |
| **Swarm membership is chosen from the task** | Ownership answers "does this agent own anything here", which fanned out to agents the task never touched, at a model call each | `selectSwarm()` | `swarm.test.js` |
| **The chat carries the build state between turns** | The entry check and the commit gate ran the project's whole suite twice per message | `run({build})` | `production-fixes.test.js` |
| **The harness's git doesn't go through `checkCommand`** | Otherwise the loop deadlocks against `no-force-push` on its first commit; the model only reaches `tools.js` | `session.js` `git()` | — |
| **Model calls run in parallel; git doesn't** | Two agents staging at once produce a diff belonging to neither | `gitLock()` | `swarm.test.js` |
| **Swarm is opt-in** | Fanning out by default multiplies a user's token bill without asking | `run()` `flags.swarm` | `swarm.test.js` |
| **Scope disjointness is conservative** | A wrong "overlaps" costs time; a wrong "disjoint" costs files | `disjoint()` | `agents.test.js` |
| **Verify once after a swarm** | Per-agent verify races on one build directory and blames each agent for the others' failures | `swarm()` | — |
| **Every run gets a session branch; chat reuses its branch; resume reuses the prior branch** | Reviewable and disposable; don't stack a branch per message; don't strand earlier attempts | `openSession()`, `sessionBranchInUse()` | `run.test.js` (branching, resume); chat branch reuse untested |
| **Senior dev is terminal; escalation refuses a spent target** | Looping is worse than asking; A↔B cycles used to run forever | `ladder()`, `escalationCycle()` | `run.test.js`, `generate.test.js` |
| **The build fixer never takes over the feature task** | It gets the build green and hands control back at the same step | `callBuildDoctor()` | `run.test.js` |
| **`fixes_build` is declared, not inferred from a name** | Works for any pack | `buildFixer()` | `custom-agents.test.js` |
| **Entry agent is chosen from repo state and task shape, never language** | A CSS tweak in a Go repo is still UI work | `classify.js` `SYSTEM` | `classify.test.js` |
| **Low confidence routes up** | Over-qualifying costs tokens; under-qualifying costs thrash | `bump()` | `classify.test.js` |
| **Idle limit of 3 prose-only replies** | Stops billing a user for "Continue" round trips | `IDLE_LIMIT` | `run.test.js` |
| **Tool calls after a control call in the same turn are skipped** | An edit after `done()` would land unverified | `attempt()` | `run.test.js` |
| **Build output keeps head and tail** | The cause is often at the start and the assertion at the end | `tail()` | `verify.test.js` |
| **A timeout isn't a red build** | Otherwise the build fixer goes looking for a bug that isn't there | `verify()` | `verify.test.js` |
| **Windows `.cmd` shims go through `cmd.exe` with a metacharacter refusal** | CVE-2024-27980 forbids spawning shims without a shell; `shell: true` would bring back injection | `resolveBin()`, `winCmd()` | `verify.test.js` |

### 6.5 Context and handoffs

| Decision | Why | Enforced in | Pinned by |
|---|---|---|---|
| **A handoff carries a record, not a transcript** | Replay cost grows quadratically in handoffs and can't cross providers; summaries lose rationale and failures | `context.js` | `context.test.js` |
| **Workers emit claims; only the engine writes records** (four invariants) | A model asked nicely will break each one; losing failed approaches is the most expensive failure | `reconcile()` | `context.test.js` |
| **The handoff report is a second model call** | One prompt for work plus report yields an optimistic report | `record()` in `run.js` | `run.test.js` |
| **`task` and `objective` are never trimmed; omissions are listed** | A brief without the task is a different task; a successor that doesn't know something was cut assumes the record is complete | `compile()` | `context.test.js` |
| **`--resume` isn't a replay** | Storing message history would write every prompt and tool result into the user's repo | `readSession()`, `resumeBrief()` | `run.test.js` |
| **Per-tier models inherit; a provider change drops an inherited `base_url`** | One manifest shape for every consumer; a carried URL points Anthropic at an OpenAI endpoint | `modelFor()` | `tiers.test.js` |

### 6.6 Providers and keys

| Decision | Why | Enforced in | Pinned by |
|---|---|---|---|
| **Listing models is the key check** | A wrong key is caught at setup, not as a 401 on the first task | `obtainKey()`, `listModels()` | `providers.test.js`, `phase1.test.js` |
| **Model ids are never hard-coded** (except `init --provider` defaults) | A list is stale the week it ships and offers models the key can't use | `providers.js` | — |
| **Non-chat models are filtered** | Speech, embedding and moderation models can't call tools | `isChatModel()` | `providers.test.js` |
| **A key only ever goes to its own provider** | Groq keys used to be sent to `api.openai.com` | `endpoint()`, `baseUrlFor()` | `providers.test.js` |
| **Keys never land in `agent.yaml`** | The privacy pitch fails the first time a user commits a key | `api_key_env` naming | `config.test.js`, `phase1.test.js` |
| **The shell beats the file** | A deliberate export mustn't be overridden by an old file | `loadEnv()` | `env.test.js` |
| **`ensureIgnored` runs before the write** | A key on disk is only acceptable while the file is ignored | `key()`, `onboard`, `chat /key`, `assignModels` | `env.test.js` |
| **The agent can't read its own key** | `.env*` is sealed `protected-read`; reading keys is the harness's job | `SEALED_FLOOR` | `hooks.test.js` |
| **Redact on the way in** | "Scrub on display" is how keys end up in bug reports | `record()`, `request()` | — (**no test covers `redact`**; worth adding) |
| **Provider limits are recovered from, or explained** | Groq free tier OTPM, rate limits; raw provider JSON never reaches the user | `request()`, `parseProviderError()`, `describeError()` | `limits.test.js` |
| **Streaming stops retrying at the first byte** | Tokens already on screen can't be replayed | `request()` stream path | — |
| **A JSON body in answer to a streaming request is parsed as JSON** | Some OpenAI-compatible servers ignore `stream: true` | `request()` content-type check | `stream.test.js` |
| **Extra keys are saved, never assigned automatically** | Which agent uses which provider decides where its code goes. `keys:` lists names only — values stay in `.env` — and doubles as the list of providers code can be sent to | `moreKeys()`, `addSavedKey()`, `assignAgent()` | `phase1.test.js` |
| **A second key for a provider gets its own variable** | Written into `GROQ_API_KEY`, it silently moved every agent on the first key to a different account | `nextKeyEnv()` | `phase1.test.js` |
| **A key is filed under the provider it belongs to** | `jr-arch key sk-ant-…` in a Groq repo used to overwrite `GROQ_API_KEY` with an Anthropic key | `key()` in `env.js` | `phase1.test.js` |
| **Fit to what is left of the minute, not to a fresh one** | Every step resends the conversation, so steps that each fit the limit spend it together. The provider reports what remains on every response; not reading it meant sending requests it would refuse | `observe()`, `liveRemaining()`, `attempt()` | `production-fixes.test.js` |
| **When nothing fits, wait exactly — once** | A refused request plus a blind backoff costs a round trip and usually more than one wait. The reset header says how long; a wait of that length is the shortest there is | `msUntilRefill()`, `attempt()` | `production-fixes.test.js` |
| **DUTIES.md is shortened only on a tight key, and says so** | It is ~1,000 tokens resent on every step. Its preamble explains the file to a person; the sections after it are the protocol. A cut that is not announced lets the model assume it has the whole file | `fitDuties()` | `budget.test.js` |
| **The reply reservation is not lowered speculatively** | Reasoning models spend output tokens thinking before a tool call; a small default would cut most steps off and double the requests. It is lowered only when a step would not otherwise fit, and a cut-off step is retried with more room | `attempt()` regrow | `production-fixes.test.js` |
| **A request is fitted before it is sent** | The loop used to send whatever had accumulated and let the provider judge. On an 8k/min key one 7.3k-token README produced "Limit 8000, Requested 10,664", and the recovery shrank the reply cap — the half that was not too big — so the retry failed larger | `fit()` in `budget.js`, called per request in `attempt()` | `production-fixes.test.js` |
| **Estimate by characters, not a tokenizer** | A tokenizer is a dependency, and this decision — does it fit, what goes — survives a 15% error. A provider's rejection reports the true count, so `calibrate()` learns the real ratio from it | `estimateRequest()`, `calibrate()` | `budget.test.js` |
| **The reply cap goes before history does** | A shorter answer still answers; a dropped file has to be read again. What is dropped leaves a note, because a model that cannot see the gap assumes it remembers the file | `fit()` | `budget.test.js` |
| **`read_file` is sized by the budget** | 200,000 characters is ~50,000 tokens: more than a small key's whole minute, so one read made every later request in the attempt unaffordable | `readCeiling()`, `read_file` | `production-fixes.test.js` |
| **A prompt over the budget stops before the first request** | It is a fact about the key that no trimming reaches, and four attempts discovering it cost four requests | `fit()` `fits:false`, `run()` | `production-fixes.test.js` |
| **Limits are read from provider headers, never hard-coded** | Every plan of every provider differs, and a table would be wrong the week it shipped. `{found:false}` when a provider reports nothing is an answer, not an error | `parseRateLimits()`, `listModels` `onHeaders` | `token-limits.test.js` |
| **The limit probe asks for one token, and reads error responses too** | It must cost nothing, and a throttled key still carries its limit headers on the 429 | `probeLimits()` | `token-limits.test.js` |
| **Setup fits the reply cap under the key's output allowance** | A provider refuses a request that merely ASKS for more than the allowance, so a too-high cap fails every task until the user finds the number | `suggestedCap()`, `onboard()` | `token-limits.test.js` |
| **A per-agent cap is written into `tiers:` line by line** | Same rule as the rest of agent.yaml: a read-modify-serialize would drop the comments that say why each agent has the model it has | `patchTierModel()` | `token-limits.test.js` |
| **An empty assistant turn is sent as "(no reply)"** | Anthropic rejects empty content, and a reply cut off at a low cap is empty — the nudge path has to survive the cap the user just set | `toAnthropicMessages()` | `token-limits.test.js` |
| **Command and build output are buffered to 64MB** | `execFileSync` kills at 1MB and reports SIGTERM, which read as a timeout — so a verbose suite came back "unknown" and the build gate silently stopped gating | `MAX_OUTPUT` in `verify.js`, `COMMAND_MAX_OUTPUT` in `tools.js` | `verify.test.js` |
| **A refused request parameter is adapted from the refusal, not from a model list** | OpenAI's reasoning models reject `max_tokens` and a non-default temperature; a hard-coded list of which models those are is stale the week it ships | `unsupportedParam()`, `learnedParams` | `production-fixes.test.js` |
| **A local `base_url` needs no key** | A local server authenticates nothing, and calling it unconfigured sent the user through onboarding every launch | `requiresKey()`, `isLocal()` | `production-fixes.test.js` |
| **DUTIES.md is optional for the classifier too** | The rest of the loop treats it as optional; the classifier threw, so deleting it broke every unpinned task | `readDuties()`, `describeAgents()` | `production-fixes.test.js` |
| **`doctor` fails at setup, not mid-task** | Small models without JSON and tools cause thrash that looks like a bug in jr-arch | `doctor.js` | — |

### 6.7 `/prompt` generation

| Decision | Why | Enforced in | Pinned by |
|---|---|---|---|
| **The model proposes, the harness writes** | Model front matter could set `fixes_build` everywhere or build a loop; model guard YAML could switch guards off | `validatePlan()`, `soulFile()`, `guardFile()` | `generate.test.js` |
| **The user sees the plan before writing** | — | `preview()` + confirm | `phase1.test.js` |
| **Retry carries the specific validation errors, or "shorter" when cut off** | "Try again" reproduces the same mistake; a truncated reply isn't a misunderstanding | `generatePlan()` | `generate.test.js` |
| **`brevity(cap)` tightens limits under a learned output cap** | A 1,000-token cap can't return six 250-word souls | `brevity()` | `limits.test.js` |
| **A failed design keeps the interview answers** | The interview is the expensive part for the person | `promptMode()` loop | `phase1.test.js` |
| **Generated guards only add protection, in `hooks/project.yaml`** | Deleting the file removes exactly what generation added | `guardFile()`, `writePlan()` | `generate.test.js` |
| **Per-agent models go in `agent.yaml` `tiers:`, never front matter** | An agent choosing where code is sent inverts the privacy model | `writeTiers()` | `generate.test.js` |

### 6.8 Packs

| Decision | Why | Enforced in | Pinned by |
|---|---|---|---|
| **A pack ships identity and guardrails, never a model** | Silently ignoring a model block would leave the user believing it was configured | `readPack()` throws | `pack.test.js` |
| **A pulled pack can tighten, never loosen**; install shows unseal attempts | Sealing holds at runtime anyway; the report adds visibility before files land | `inspectHooks()` + `seal()` | `pack.test.js` |
| **Every pack path is confined; symlinks dereferenced or refused** | The pack author controls those strings | `confine()`, `installPack()` | `pack.test.js` |
| **Validate before writing anything** | Half a pack in `.gitagent/` is worse than none | `init()` `loadPack` before `mkdir` | `pack.test.js` |
| **`pull` is a merge, not a reinstall** | `.gitagent/` is meant to be edited; `.pack.lock` distinguishes "you changed it" from "the pack changed it" | `planUpdate()` | `pull.test.js` |
| **Lock is JSON, no timestamp** | Machine-only file; a changing timestamp adds noise to every diff | `writeLock()` | `pull.test.js` |
| **`installPack` and `packFiles` share one skip filter** | Diverging makes the lock describe different files than landed | `SKIP` | `pull.test.js` |
| **Pull follows the installed ref, not the pinned commit** | Pinning records what you have; it doesn't freeze you | `pull()` | `pull.test.js` |
| **Only routing keys that already exist are patched** | A key the user deleted was deleted on purpose | `rewriteManifest()`, `init()` | — |

### 6.9 Parsing and files

| Decision | Why | Enforced in | Pinned by |
|---|---|---|---|
| **Strict YAML subset that throws rather than guesses** | A parser that guesses on a guardrail file produces guardrails that are silently off | `yaml.js` | `yaml.test.js` |
| **YAML 1.1 booleans** | `overridable: no` must be `false` | `TRUE` / `FALSE` sets | `yaml.test.js` |
| **`agent.yaml` writes are line-based** | Serialising would lose the comments, which are half the documentation | `patchSection`, `upsertSection` | `config.test.js` (patching; comment preservation not asserted) |
| **Single-line front-matter fields are collapsed** | A newline in `role` made front matter unparseable, and the agent silently ran unscoped and non-terminal | `line()`, `yamlScalar()` | `generate.test.js` |
| **Version read from `package.json`** | 0.1.1 shipped reporting 0.1.0 | `bin/jr-arch.js` `VERSION` | — |
| **`repoRoot()` falls back to cwd** | Works in a not-yet-initialised directory | `paths.js` | — |

### 6.10 Terminal UX

| Decision | Why | Enforced in | Pinned by |
|---|---|---|---|
| **One readline interface, passed down** | A second interface paused stdin on close and left the chat unresponsive | `run()` `prompter` param, `ask()` | `terminal.test.js` |
| **Secrets masked with `*`, label is readline's own prompt** | Echo-off plus a separately written label looked dead after readline's redraw | `createPrompter` `_writeToOutput` | `terminal.test.js` |
| **Windows Ctrl+V reads the clipboard** | A raw Windows console sends a literal ^V | `keypress` handler | `terminal.test.js` |
| **Per-question `close` listener removed** | Leaked listeners triggered a Node memory-leak warning after 11 questions | `question()` | `terminal.test.js` |
| **Optional menu items go last** | Otherwise the same keypress picks different things depending on whether the network responded | `assignModels`, `pickModel`, `promptMode` | — |
| **Notices go to stderr on their own line** | Must never corrupt piped stdout or an open progress line | `defaultNotice()` | `limits.test.js` |
| **Streamed text is dimmed and indented per delta** | Reads as one column with the tool log; colour per delta, not per character | `streamWriter()` | — |

---

## 7. Gotchas

Traps that have already caused real bugs.

1. **`name:` appears under both `metadata:` and `model:`** in `agent.yaml`. A
   file-wide replace changes the wrong one, which has happened once. Always use
   `patchSection(text, 'model', 'name', …)`.
2. **Hand-rolled argv can't infer arity.** A valueless flag not in `BOOLEAN`
   swallows the next token.
3. **Python heredocs mangle backslashes** in JS source (`\n` → newline,
   `\s` → `s`). Use the Edit tool or raw strings.
4. **Plain streams test the wrong readline path.** Use the fake TTY.
5. **`frontMatter()` failing is silent.** The agent still runs, with defaults.
   `/check` and `/smoke` exist to surface it.
6. **readdir order isn't stable across machines.** `readAgents()` sorts by
   priority, then name. Keep it that way, or swarms become unreproducible.
7. **`git diff` doesn't show new files** unless they're `--intent-to-add`.
   `diffSince()` does that, scoped to the attempt's paths.
8. **`git clean` takes no path list.** It would delete other agents' untracked
   files, so `revertAttempt` uses `rmSync` per path.
9. **Chat branch reuse:** without `sessionBranchInUse`, every message cut a new
   branch stacked on the last.
10. **Resume must reuse the prior branch,** or earlier attempts end up on a
    branch nobody looks at.
11. **Some OpenAI-compatible servers ignore `stream: true`.** Check the content
    type before parsing SSE.
12. **An `sk-` prefix is shared** by Anthropic, OpenRouter and OpenAI keys.
    Detection order matters.
13. **Groq's TTS model id is `orpheus`**, with no "tts" in it. `isChatModel`
    names it explicitly.
14. **Anthropic `/v1/models` paginates at 20.** Use `?limit=1000`.
15. **Reasoning models wrap output in `<think>`** with braces inside.
    `extractJson` strips it first.
16. **A clone's nested `.git`** breaks the user's working tree if it's copied.
    `fetchPack` deletes it.
17. **A pack's `.gitignore` would add rules to the user's project.** It's in
    `SKIP`.

---

## 8. Change history

Commit-by-commit, with what changed and why. All dates are 2026.

| Date | Commit | Change | Why it mattered |
|---|---|---|---|
| 09-02 | `4357e12` | **initial**: CLI scaffold + four-tier personas | the `.gitagent/` scaffold and the default pack |
| 09-02 | `91e4708` | **fix**: scope `config set` to the named section | `name:` under `metadata:` was being overwritten; `patchSection` becomes the only implementation |
| 09-02 | `937e70a` | **feat**: guardrail engine with sealed hooks and a command gate | enforcement moved out of prompts into the harness |
| 09-02 | `9ab24ab` | **feat**: tier classifier | strict JSON `{tier, confidence, reason}`, floor bump, degraded fallback |
| 09-10 | `78c259f` | **fix**: gate the read tool behind protected-read | `cat .env` was blocked but `read_file(".env")` wasn't |
| 09-10 | `0dd961d` | **feat**: install agent packs from a git repo | `fetchPack` / `readPack` / `confine`; refuse `model:` |
| 09-10 | `a052b0c` | **feat**: pull, to update a pack without losing edits | `.pack.lock` and the three-way plan |
| 09-11 | `8bba7c7` | **feat**: the execution loop | `run`, ladder, attempts, sessions, verify, commit |
| 09-11 | `c896596` | **feat**: stream model output | SSE parsing; long attempts no longer look hung |
| 09-11 | `3c15b1c` | **feat**: rename to jr-arch, add `detect` and `run --resume` | resume rebuilds a brief, not a replay |
| 09-11 | `218510a` | **feat**: `jr-arch key` | `.gitagent/.env`, shell wins, `ensureIgnored` first; no `export` needed on Windows |
| 09-11 | `3ab0ac4` | **chore**: prepare for npm publish | `files`, `bin`, `prepublishOnly` |
| 09-12 | `9b4d9ab` | **feat**: per-tier models, and context that survives crossing between them | `modelFor`, `tiers:`, `context.js` ledger + compile + second-call reports |
| 09-12 | `cfb835a` | **feat**: agents are the unit: `add-agent`, `add-guard`, chat front door | directory as registry; guards additive; no root SOUL/RULES |
| 09-12 | `b3fa4d4` | **feat**: swarm, with per-agent rollback | `swarmable` / `disjoint` / `gitLock`; `revertAttempt` goes per-file |
| 09-12 | `a16d272` | **refactor**: the default agent names leave the code entirely | routing declared in front matter; `custom-agents.test.js` |
| 09-12 | `6550df8` | **docs**: renumber the Next list | — |
| 09-12 | `53978b1` | **fix**: read the version from `package.json` | 0.1.1 reported 0.1.0 |
| 09-15 | `76d7822` | **fix**: four bugs in shipped code, found while building phase 1 | custom-named guards never evaluated (shape enforcement); ladder escalating into a spent agent; checkpoint asked after the action; custom command-guard paths not covering `read_file` |
| 09-15 | `340a2fc` | **feat**: phase 1: guided setup, `/prompt`, `/dev`, smoke tests | onboarding via model listing; provider registry; model-proposes/harness-writes; `/check`; `/smoke` |
| 09-15 | `f5b8c5c` | **fix**: the chat works in a real terminal | single prompter; masked secret echo; Windows Ctrl+V; listener leak; `terminal.test.js` |
| 09-15 | `ddbabb3` | **fix**: handle provider limits instead of dying on them | `ProviderError` kinds, OTPM shrink + learned caps, rate-limit waits, JSON-for-stream fallback, `/prompt` failure menu, `brevity()` |
| uncommitted | — | **request budgets**: `src/budget.js`, per-request fitting, budget-sized reads, the pre-flight estimate in chat, `model.tokens_per_minute` measured at setup | a small free tier now works and explains itself instead of failing four times |
| uncommitted | — | **twelve production fixes**: secret-scan token matching, pathspec commits, the no-commit-repo guard, swarm build gating and task-aware selection, DUTIES-less classification, `/undo` guards, local endpoints without keys, request-parameter adaptation, 64MB output buffers, the empty assistant turn, the chat's build-state handoff; plus templates that only declare what is read | each one failed quietly, which is the kind this project treats as worst |
| uncommitted | — | **token limits**: `src/limits.js`, `jr-arch limits` / `/limits`, rate-limit headers shown at setup, per-agent `max_tokens` via `patchTierModel`; ENOBUFS and empty-assistant-turn fixes | a key's allowance is visible before the first task, and the reply cap is fitted to it |
| uncommitted | — | `package.json` 0.1.2 → 0.1.3; `.gitignore` gains `.gitagent/.env` and `.gitagent/.session/` | this repo has been dogfooding itself (`.gitagent/` present, session branch checked out) |

---

## 9. Known gaps and drift

These are places where the code, its comments, the templates and `CLAUDE.md`
disagree. Everything in 9.1 and 9.2 has now been fixed; the entries are kept
because each one describes a shape of bug worth recognising again.

### 9.1 Fixed: bugs

| # | Was | Fix | Pinned by |
|---|---|---|---|
| B1 | **A swarm committed without its build gate.** Frames closed with no `verify`, so `checkCommit` saw `null`, which only warns. | `swarm()` verifies once, routes a red build to the `fixes_build` agent, and stamps the result onto each done frame before `commit()`. | `swarm.test.js` |
| B2 | **The commit staged everything, but the gate scanned only `touched`.** `git add --all` swept in a sibling's files and the user's own uncommitted work, unscanned and under the agent's name. | `commitAttempt` adds and commits with a pathspec of `attemptPaths(frame)`, and `commit()` gates on that same set. | `production-fixes.test.js` |
| B3 | **The classifier threw without DUTIES.md**, a file the rest of the loop treats as optional. | `readDuties` falls back to the default entry rules, and the prompt always carries each agent's own declaration. | `production-fixes.test.js` |
| B4 | **`/undo` was `git reset --hard HEAD~1`** with no check of whose commit it was or what else it would take. | It refuses a commit without `via jr-arch`, refuses a dirty tree, and then asks. | manual (chat command, not exported) |
| B5 | **The chat setup check special-cased `OLLAMA_API_KEY`**, so a keyless local server looked unconfigured on every launch. | `requiresKey()` is false for Ollama and for any local `base_url`; the chat asks it per agent. | `production-fixes.test.js` |
| B6 | **`secret-scan` blocked ordinary code containing `sk-`** — `task-row`, `risk-high`, `disk-usage` — by a sealed hook nobody could switch off, at edit time and again over whole files at commit time. | Prefixes match per token, anchored, and a prefixed token must also look like a credential (length, mixed body, entropy). `-----BEGIN` stays unconditional; `data:` URIs skip the entropy rule. | `hooks.test.js` |
| B7 | **A repo with no commits got no branch and no rollback**, silently — the first-run path, since the chat passes `--allow-dirty`. | `requireGit()` refuses a non-repo or an empty history with the command that fixes it; `--no-git` is explicit consent. | `production-fixes.test.js` |
| B8 | **Output over 1MB** killed the child with ENOBUFS reported as SIGTERM, read as a timeout, so a verbose suite came back "unknown" and the build gate stopped gating. | 64MB buffers in `verify.js` and `tools.js`, and ENOBUFS handled before the timeout branch. | `verify.test.js` |
| B9 | **An empty assistant turn** went to Anthropic as `content: []`, which the API rejects — reachable whenever a reply is cut off at a low `max_tokens`. | `toAnthropicMessages` substitutes a `(no reply)` text block. | `token-limits.test.js` |
| B10 | **OpenAI reasoning models were unusable**: they reject `max_tokens` and a non-default temperature, and both were always sent. | The request layer reads the refusal, adapts the payload, remembers it per provider and model, and resends. No model ids are hard-coded. | `production-fixes.test.js` |
| B11 | **`--swarm` was not task-aware**: it fanned out to every parallel agent owning any file in the repo, at one model call each. | `selectSwarm()` asks which agents the task spans; ownership is only the fallback. | `swarm.test.js` |
| B15 | **A per-minute limit was fitted per request, so steps spent it together.** Each step resent the conversation; four steps that each fitted 8,000 could spend it twice, and the next sat out a 50-second wait after a refused request. | Remaining tokens read from every response; each step fitted to what is left; an exact wait for the reset when nothing fits; DUTIES.md shortened on a tight key; cut-off replies retried with more room. | `production-fixes.test.js`, `budget.test.js` |
| B14 | **A plain folder was refused with advice nobody could follow.** Setup and `/prompt` both ran and spent model calls, then every task was refused with a pointer to `--no-git` — a launch flag, unreachable from inside a chat. "yes" was read as a new task. | `ensureRepo()` offers `git init` and a first commit during setup (before `/prompt`), and again the moment a chat task is refused; `initialCommit()` ignores `.gitagent/.env` and `node_modules/` before staging. Declining asks whether to work without git for the session. | `production-fixes.test.js` |
| B13 | **A request that did not fit was discovered by being refused.** The reply cap was shrunk while the input grew, so the retry failed larger, and the attempt was spent. | Budget measured at setup, every request fitted under it, `read_file` sized to it, and an impossible prompt refused before the first call. | `production-fixes.test.js`, `budget.test.js` |
| B12 | **The chat ran the project's test suite twice per message** (entry state, then the commit gate). | `run()` accepts the build state the previous turn verified; the post-task verify still runs for real. | `production-fixes.test.js` |

### 9.2 Fixed: configuration that was written but not read

| # | Was | Fix |
|---|---|---|
| C1 | `git.*` was read from `agent.yaml` but shipped in `config/default.yaml`, which nothing reads | the `git:` block now ships in `agent.yaml`, where it is read |
| C2 | `sandbox:` declared but not implemented | removed from the template |
| C3 | `post_run: session-summary` declared but never executed | removed; `/check` warns if a guard file declares `post_run` |
| C4 | `memory:` config nothing reads | removed; `memory/MEMORY.md` now says what it actually is |
| C5 | `identity:` pointed at root `SOUL.md` / `RULES.md`, removed by design | removed from the template |
| C6 | `routing.diff_line_ceiling` parsed but unused | removed; `hooks.yaml` `max_lines` is the single source |
| C7 | `agents:` parsed into `manifest.agents`, unused | removed |

`patchSequence` in `config.js` is still exported and tested but no longer called
by anything; it is kept as a tested utility rather than deleted.

### 9.3 Fixed: default agent names in messages and probes

The routing logic never knew the default names; these were messages and a probe
that did.

| Was | Fix |
|---|---|
| `doctor` probed for `tier: "junior-dev"` and advised `routing.entry senior-dev`, which fails in a repo without that agent | the probe asks for a neutral value, and the advice names the most senior agent actually installed |
| build-gate said "Route to build-doctor" | "Hand off to whichever agent repairs builds" |
| `detect` said "will likely route to build-doctor first" | "to a build-repair agent first" |
| the shipped manifest said "Four-tier" and listed the four names beside `entry:` | neither; `entry: auto, or the name of an installed agent` |
| the help example was `--agent senior-dev` | `--agent <name>` |

### 9.4 Fixed: stale comments and dead code

| Was | Fix |
|---|---|
| the dirty-tree error said failed attempts are rolled back with `git reset --hard` | "rolled back through git" — the revert has been per-file since the swarm landed |
| `handoffPayload` in `session.js`, unused since `compile()` replaced it | removed |
| `post_run` hooks loaded and silently never executed | `/check` now warns that they protect nothing |

`CLAUDE.md` still carries two statements this work invalidates: the dirty-tree
decision describes `git reset --hard`, and a gotcha describes a
`git clean -fd -e .gitagent/.session` that `revertAttempt` no longer runs. It is
the author's file, so it is flagged here rather than rewritten.

### 9.5 Limitations by design (worth knowing)

- The command guards analyse argv. They can't see what a permitted interpreter
  does (`node -e`, `python -c`) — which is why the commit gate now scans
  everything a commit will contain, not just what `write_file` touched.
- `list_files` and `repoFiles` don't respect `.gitignore`; they skip a fixed
  directory list.
- Memory of learned output caps lasts for the process only.
- `doctor` probes only the default model, not per-tier models.
- Swarm has no escalation and uses only the first multi-member group.
- `routing.entry` pins one agent for every task.

### 9.6 Decisions with no test

These are marked "—" in the decisions log. Each one is a place where a
regression could land unnoticed:

- `redact()`: key redaction in transcripts and provider errors
- `askLock` serialising swarm checkpoints; `ask()` declining when
  non-interactive; the per-attempt "no" memory
- chat never passing `--yes`; chat reusing its session branch
- verify running once after a swarm
- `hooks.yaml` loading last among guard files
- secret masking in block reasons
- streaming not retrying after the first byte
- routing keys: only existing ones patched on `init --from` / `pull`
- `agent.yaml` comments surviving `patchSection` / `upsertSection`
- optional menu items staying last

---

## 10. Roadmap

From `CLAUDE.md` "Next", plus the gaps above that most need fixing.

| # | Item | Notes |
|---|---|---|
| 1 | **A real task against a real model** | See procedure §5.12. Everything else is lower priority, and every fix in §9 was verified against scripted models only |
| 2 | Publish 0.1.3 | See §5.11 |
| 3 | Bring `gitagent-default` to the current format | Front-matter routing; remove root SOUL/RULES |
| 4 | `routing.entry` still names one agent | |
| 5 | Swarm still does not escalate | Ladder and swarm remain two paths through `run()`; selection is now task-aware but a failed swarm agent has nowhere to go |
| 6 | `doctor` probes only the default key | Iterate `keyEnvs()` / `modelFor` per agent |
| 7 | Token accounting per agent and per model | The budget work estimates what a request *will* cost and `limits` reports the allowance; nothing yet records what a finished run actually spent |
| 7b | A fallback provider chain | `model.fallback:` used on a too-large or rate-limit error. Per-agent models already cover this by hand (see README "Working under a small limit"); a chain would automate it, and must stay explicit config because it decides where code is sent |
| 8 | Memory is inert | `memory/MEMORY.md` is documentation. Either feed it to agents or drop it |
| 9 | `post_run` hooks are loaded but never executed | Run them, or stop loading the phase |

---

## 11. Maintainer troubleshooting

| Problem | Fix |
|---|---|
| Tests hang | Something created a real prompter; pass `scriptedPrompter`. Or a test ran `verify()` on a repo with a slow test script |
| `scripted prompter ran out of answers at: …` | The flow asks a question the test didn't expect. That's the intended failure, so decide whether the question should exist |
| Tests pass locally, fail on Windows | Path separators (normalise to `/`), `.cmd` shims, or a CRLF in a fixture (`parseYaml` normalises; your assertion may not) |
| `MaxListenersExceededWarning` | A listener added per prompt and not removed; see `question()` |
| Chat stops responding to keys after a checkpoint | A second readline interface was created; pass the prompter through |
| Colour codes in test snapshots | `util.js` colours only when stdout is a TTY and `NO_COLOR` is unset; tests run without a TTY |
| A custom guard loads but never fires | It has no `paths` / `commands`, its `applies_to` excludes the tier, or its name collides with a built-in in `BUILTIN_EDIT` / `BUILTIN_COMMAND` |
| An agent is ignored | No `SOUL.md` in its folder, or the folder isn't directly under `agents/` |
| Wrong agent picked | `routing.entry` pinned; red build with a `fixes_build` agent; low confidence bumped it up. `--dry-run` prints the source |
| Publish blocked | `prepublishOnly` ran `node --test` and something failed |

---

## 12. Glossary

| Term | Meaning |
|---|---|
| **agent / tier** | A folder under `agents/` with `SOUL.md`. "Tier" is the older name, and it's still used in code (`tier`, `tiers:`) |
| **pack** | A git repo with `gitagent.yaml` that installs a set of agents, DUTIES and hooks |
| **hook / guard** | A YAML-declared rule in `hooks/*.yaml`, enforced by `hooks.js` |
| **sealed hook** | One of four hooks whose severity and enabled state come from code and whose lists can only grow |
| **checkpoint** | A warning that stops and asks a human before the action |
| **ladder** | Sequential attempts, retries and escalations across agents |
| **attempt / frame** | One agent's try at a task; the frame records its sha, touched files, steps, status and diff |
| **nested attempt** | The `fixes_build` agent running inside a failed attempt, returning control |
| **swarm** | Concurrent attempts by parallel, disjointly-scoped agents |
| **ledger** | The canonical execution record that handoff briefs are compiled from |
| **claim** | Something a model said; recorded as unverified unless the engine observed it |
| **brief** | The compiled ledger handed to the next attempt |
| **session** | One `run`: a branch, a `.session/<id>/` directory, and a transcript |
| **verify** | The project's own build/test command; green / red / unknown |
| **entry** | The first agent chosen for a task |
| **terminal** | An agent that escalates to the human instead of to another agent |
| **scope / owns** | Globs an agent claims; used for swarm safety, rollback attribution and partitioning |
| **manifest** | `.gitagent/agent.yaml` |
| **lock** | `.gitagent/.pack.lock`: what a pack installed, for `pull` |
