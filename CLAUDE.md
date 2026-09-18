# jr-arch

CLI that scaffolds a GAP-format `.gitagent/` folder into a user's repo, pre-filled
with four coding personas and guardrails. Bring-your-own model and key.

Node, ESM, **zero runtime dependencies**. Keep it that way — `npx` speed is a
feature, and arg parsing is hand-rolled in `bin/jr-arch.js` on purpose.

## Layout

```
bin/jr-arch.js     entry, arg parsing, command dispatch
src/init.js             scaffold .gitagent/, patch agent.yaml, guard .gitignore
src/config.js           read/write manifest; readManifest() is the shared reader
src/pack.js             fetch / validate / install an agent pack from a git repo
src/pull.js             update an installed pack, merging against .pack.lock
src/run.js              the execution loop: classify -> attempt -> escalate
src/tools.js            the model's tool surface; every call passes a hook
src/session.js          session branch, transcript, attempt frames, handoff payload
src/verify.js           detect and run the project's own build/test command
src/detect.js           stack / lockfile / verify-command report
src/env.js              .gitagent/.env loading and the `key` command
src/context.js          the ledger: claims -> records, and the handoff compiler
src/agents.js           the installed agents, read from their own front matter
src/add.js              add-agent / add-guard
src/chat.js             the default command: onboarding, then /chat /prompt /dev
src/onboard.js          first run: key -> models -> scaffold -> mode
src/providers.js        provider registry, key detection, live model listing
src/generate.js         /prompt: interview -> plan -> validate -> write
src/dev.js              /dev: scaffold agents and guards, /check
src/smoke.js            per-agent smoke test
src/prompter.js         every question the CLI asks, scriptable in tests
src/tree.js             .gitagent/ drawn with what each file is for
src/personas.js         list / add / remove tiers, --from <git-url> pull
src/hooks.js            guardrail engine; sealed hooks live here, not in yaml
src/classify.js         one model call -> {tier, confidence, reason}
src/provider.js         anthropic + openai wire formats, streaming, key redaction
src/yaml.js             strict YAML subset parser (zero-dep)
src/doctor.js           model capability probe (structured output + tool calling)
src/paths.js            repoRoot() walks up to .git; TEMPLATES resolution
src/util.js             color + log helpers
templates/              bundled default pack, copied into the user's .gitagent/
test/                   node --test, no runner
```

## Status

Phase 1 is built: `npx jr-arch` onboards interactively (paste a key, the
provider is detected, the key is checked by listing its models, pick one,
scaffold, pick a mode), then opens a chat with `/prompt`, `/dev` and `/chat`.
Providers: Anthropic, Gemini, Groq, OpenAI, OpenRouter, xAI, Ollama, any
OpenAI-compatible endpoint. 512 tests, `node --test`, no runner.

The key and model-listing path has been exercised against the real Groq API.
The agent loop itself has still only met a scripted model — whoever has a key
first should run a real task on a throwaway repo before trusting it.

## Decisions already made — do not relitigate without reason

**In /prompt, the model proposes and the harness writes.** The model returns a
plan as JSON; `validatePlan` checks every field and `soulFile`/`guardFile` build
the files from the validated values. Only the prose bodies of SOUL.md and
RULES.md are written as the model produced them. Model-authored front matter
could declare `fixes_build` on every agent or an escalation loop; model-authored
guard YAML could try to switch a guard off. The user always sees the plan
before it is written.

**A guard is enforced by what it declares, not by its name.** `checkEdit` and
`checkCommand` have dedicated logic for the built-in hooks, then enforce every
other hook by shape: `paths`, `commands`, `severity`, `applies_to`. Before this,
a hook with its own name — from `add-guard` or `/prompt` — loaded, reported
success, and was never evaluated. A guardrail that silently does nothing is
worse than none, because it is believed. `test/regressions.test.js` pins it.

**A command guard that names a path also covers `read_file`.** An edit guard
does not: agents need to read code they may not change.

**Listing models is the key check.** Onboarding proves a key works by listing
what it can reach, so a wrong key is caught at setup rather than as a 401 on
the first task. Model IDs are never hard-coded — a list is stale the week it
ships and would offer models the key cannot use. `isChatModel` drops speech,
embedding, moderation and guard models, none of which can call a tool.

**A key only ever goes to its own provider.** `endpoint()` resolves through the
registry in `providers.js`. The request layer used to fall back to
`api.openai.com` for anything that was not Anthropic, so a Groq key with no
base_url would have been sent to OpenAI. `openai-compatible` with no base_url
now refuses rather than guessing.

**Setup does not ask questions nobody can answer.** With no TTY, `jr-arch`
explains what to run instead of hanging on a prompt. Every interactive flow
takes a prompter, so tests drive it with `scriptedPrompter` and never need a
terminal — and a scripted prompter throws when it runs out, so a flow that asks
one question too many fails instead of silently taking a default.

**No default agent name appears in executable code.** Not in `classify.js`, not
in `run.js`, not in `DUTIES.md`, not in `agent.yaml`. Every routing decision an
agent used to be looked up for is now something the agent DECLARES, in its own
front matter: `priority`, `owns`, `parallel`, `escalates_to`, `terminal`,
`fixes_build`, `attempts`. `test/custom-agents.test.js` is a repo whose agents
are called medic / scout / archivist, and it exists to keep it that way — if a
name creeps back into the code, that file fails.

**The four tiers are a DEFAULT PACK, not the product.** Users install whatever
agents they want from wherever they want. Nothing may assume a fixed set, a
fixed count, or a fixed ladder. `readAgents()` reads the directory; twelve
agents is as valid as four, and zero is an error rather than a fallback to the
defaults.

**There is no global SOUL.md or RULES.md.** Identity the harness injects into
every agent makes the harness the co-author of agents it did not write, and
stops a pulled agent's own file from being the thing that defines it. Shared
constraints live in `hooks/`, which is enforced rather than suggested. This was
a deliberate removal, not an oversight — do not add a root identity file back.

**An agent describes itself.** Priority, scope, parallelism, who it escalates
to, whether it is terminal, whether it repairs builds, and how many attempts it
gets are all front matter in the agent's own SOUL.md — not harness config. The
directory is what installs it: no registry entry, no manifest list to keep in
sync, and deleting the folder uninstalls it.

**There is no `agents:` list in `agent.yaml`.** `readAgents()` reads the
directory. A manifest list that has to agree with the filesystem is a second
source of truth and the two drift — which is exactly what happened once the run
loop started reading the directory and everything else kept reading the list.

**A failed agent rolls back its own files and nothing else.** `revertAttempt`
restores only what the attempt touched — `git checkout <sha> -- <path>` for
files that existed, delete for files it created. A whole-tree `git reset
--hard` would take a sibling's successful work in a swarm, and in chat it would
take an earlier accepted turn that has not been committed yet. Scope widens the
set to anything dirty the agent owns, so a formatter run via run_command is
caught too; an agent with no declared scope gets only what it explicitly wrote,
because "everything dirty" would sweep up work that is not its own.

**Model calls run in parallel; git does not.** The index is one shared mutable
thing, and two agents staging at once produce a diff belonging to neither.
`gitLock` serialises the bookkeeping while the slow part stays concurrent.

**A swarm is opt-in.** `--swarm` fans out; the default runs one agent. Fanning
out by default would multiply a user's token bill the first time they installed
two scoped agents, without them asking.

**Scope is what makes parallelism safe.** Agents write into one working tree,
so two agents may run concurrently only when both opted in and their scopes are
provably disjoint. `disjoint()` compares literal prefixes and treats anything
it cannot prove as overlapping: being wrong that way costs time, the other way
costs the user's files.

**Guards are additive.** `loadHooks` reads every YAML file in `hooks/`, so
`add-guard` extends the set rather than replacing it. hooks.yaml loads last so
the repo's own file wins a conflict, and the sealed hooks still cannot be
relaxed by any of them.

**`jr-arch` with no arguments is the chat.** Chat is a front door onto `run`,
never a second execution path — a second path is a second place for the hooks
to be missing. It passes `--allow-dirty`, because across turns the tree holds
the agent's own accepted work, and `--quiet`, because the standing facts are
banner material once and noise every message after. It does NOT pass `--yes`.

**Keys never land in `agent.yaml`.** The manifest stores an env var *name*
(`api_key_env`), never a key. The value lives in the shell or in
`.gitagent/.env`, which is gitignored and written 0600 by `jr-arch key`. The
privacy pitch dies the first time a user commits a key.

**The shell beats the file.** `loadEnv` only fills a variable the environment
left unset. Someone who exported a key for this one command must not be
silently overridden by a file they set up weeks ago.

**`ensureIgnored` runs before the write, never after.** Putting a key on disk
is only acceptable while the file is genuinely ignored, so `jr-arch key`
verifies — and repairs — the `.gitignore` rule first.

**The agent cannot read its own key.** `.env*` is a sealed `protected-read`
path, so `read_file(".gitagent/.env")` and `cat .gitagent/.env` are both
blocked even if the user empties `hooks.yaml`. Reading it is the harness's job,
the same separation as the harness's own git.

**No telemetry, ever.** The CLI makes zero network calls of its own. The only
outbound traffic is the user's configured provider, plus an explicit
`personas add --from <git-url>`. `config/default.yaml` writes `telemetry: enabled: false`
into the scaffold so the claim is visible and checkable. Do not add analytics,
crash reporting, or a version-check ping.

**Guardrails belong in `hooks/hooks.yaml`, not in RULES.md prompts.** Users bring
arbitrary models; a weak one ignores its own rules file. Anything that actually
matters must block at the harness level. `secret-scan` and `no-force-push` are
non-overridable by design; everything else is per-repo opt-out.

**Entry tier comes from repo state and task shape, never from language or
framework.** A CSS tweak in a Go repo is still `ui-editor` work.

**Build doctor never owns the feature task.** It is delegated to, gets the build
green, hands control back to the calling tier at the same step.

**Senior dev is terminal.** It escalates to the human, not to another agent.
Two failed attempts, then stop and report.

**`ui-editor` is a peer of `junior-dev`, not below it.** Split by domain, not
seniority — it hands sideways.

**A pack ships identity and guardrails, never a model.** `readPack()` refuses a
`gitagent.yaml` declaring `model.provider` / `api_key_env` / `base_url` outright
rather than ignoring it. A pack choosing where someone else's source code gets
sent is the whole privacy claim inverted, and silently dropping the block leaves
the user believing it configured something.

**A pulled pack can tighten guardrails, never loosen them.** Enforced by the
sealing in `hooks.js` at load time, so it holds at runtime regardless. What
`init --from` adds is *visibility*: the install report shows every attempt to
unseal a hook before the files land.

**`pull` is a merge, not a re-install.** `.gitagent/` is meant to be edited —
that is the pitch — so a persona you tuned is never overwritten without
`--force`. `.pack.lock` is the third point that makes this decidable: comparing
the working file against the *previously installed* hash is what separates "you
changed it" from "the pack changed it". Without a lock, every difference is
treated as yours.

**A blocked hook is a tool error, never an exception.** The block reasons in
`hooks.js` are written as instructions to the agent — "Hand off rather than
crossing the boundary", "Remove it or read the value from an environment
variable". The model gets them and corrects. Throwing would end the run and
waste every one of them.

**`run` refuses to start on a dirty working tree.** Failed attempts are rolled
back with `git reset --hard`, so this guard is the precondition that makes the
revert safe: the only work it can destroy is the agent's own. `--allow-dirty`
exists, but weakening the default means rewriting `revertAttempt`.

**The harness's own git does not go through `checkCommand`.** That gate stops
the MODEL shelling around the write hooks. Routing our own branch and commit
calls through it would deadlock the loop against `no-force-push` on its first
commit. The model only ever reaches `tools.js`.

**A human checkpoint declines when non-interactive.** `--yes` has to be typed by
a person. A dependency change waved through because the run happened to be in CI
is precisely what the DUTIES.md checkpoint list exists to prevent.

**A checkpoint is asked before the action, and "no" is a tool error.**
`tools.js` calls `ctx.approve` between the hook check and the write or command.
It used to return checkpoints alongside the result, so `npm install` had already
run when "Allow?" appeared. A decline goes back to the model like a block, and
is remembered for the attempt so the same question is not asked twice. Swarm
prompts queue on `ctx.askLock` so two agents never ask at once.

**Provider limits are recovered from, and explained when they cannot be.**
`request()` in provider.js parses the error into a `ProviderError` with a
`kind`. "Request too large … (OTPM): Limit 1000, Requested 2581" (Groq free
tier) resends with a smaller `max_tokens` and remembers the cap per model;
a short rate limit is waited out (up to 90s) with a notice on stderr; a daily
limit or an unshrinkable request is reported in a sentence that names what to
do. Raw provider JSON never reaches the screen. `/prompt` keeps the interview
answers when design fails and offers retry / defaults / /dev / another model.

**Streaming stops retrying at the first byte.** `post` can safely replay a
request that never produced a response; `postStream` cannot, because tokens
already handed to the caller are already on the user's screen. A mid-stream
failure is an error, not a retry.

**`--resume` is not a conversation replay.** The message history is never
stored — doing so would write every prompt and tool result into the user's
repo. A resume rebuilds the same brief a handoff carries: the original task,
the tier history, and the failed diffs. That is what DUTIES.md already says an
escalation needs, so a resumed tier reads its history in a format it knows.

**A handoff carries a record, not a transcript.** `src/context.js` keeps
canonical execution state and compiles a bounded brief from it. Replaying the
conversation costs tokens quadratically in the number of handoffs and cannot
cross providers at all — tool-call ids and message shapes are provider-specific,
and the successor may be a different model. Summarising instead loses exactly
what a successor needs. So the ledger records decisions with rationale, files
the harness saw written, open issues, and failed approaches, and the compiler
renders them in priority order within `routing.context_budget`. A junior→senior
handoff compiles to ~700 characters.

**A worker emits claims; only the engine writes records.** Four invariants, each
because a model asked nicely will break it: an unverified claim never closes an
issue; a file named only in prose is recorded unverified; failed attempts are
append-only; provenance is stamped by the engine, never self-reported. The third
matters most — a senior that can drop the junior's failed approach will
re-attempt it.

**The handoff report is a second model call.** Asking for the work and the
report in one prompt biases both toward the same tone: a model mid-task writes
an optimistic report. It costs one small call per handoff.

**`task` and `objective` are never trimmed.** A brief that loses the task is not
a smaller brief, it is a different task. Everything else trims before it drops,
and whatever was cut is named in the package — a successor that does not know a
section was omitted assumes the record is complete.

**Per-tier models inherit, and a provider change drops an inherited base_url.**
`modelFor()` returns the same shape `readManifest` does, so every consumer keeps
one shape to speak. Carrying a base_url across a provider change points an
Anthropic tier at an OpenAI-compatible endpoint and fails unreadably.

**DUTIES.md names no agent.** It is the protocol — entry, escalation, what
travels with a handoff, what a human checkpoint is — and nothing else. Which
agents exist and what each one does is theirs to declare. The loop passes
whatever is there and passes nothing when the file is gone, so code that treats
a missing or rewritten DUTIES.md as an error is wrong.

**`doctor` fails at setup, not mid-task.** The tier ladder needs strict JSON and
tool calling. Small local models often give neither and the ladder degrades into
retry thrash that reads as a bug in this tool. Probe, then tell the user to drop
to single-tier if it won't hold.

## Gotchas

`agent.yaml` has `name:` under **both** `metadata:` and `model:`. A file-wide
regex replace clobbers the wrong one — this bug already happened once. `init.js`
scopes the patch to the `model:` block. Any new manifest edit must do the same.

`readManifest()` in `config.js` now parses through `src/yaml.js` rather than the
old section-scoped regexes — that was the documented escape hatch and it has
been taken. `yaml.js` is a strict subset: it throws on anchors, aliases, merge
keys, flow collections, and tab indentation rather than guessing. Keep it that
way; a parser that guesses on a guardrail file is worse than one that refuses.

Writes to `agent.yaml` still go through the line-based patchers, not the parser:
`patchSection` for a scalar, `patchSequence` for the `agents:` list,
`upsertSection` for whole blocks like `source:`. Round-tripping through the
parser would serialize away every comment, and the comments in that manifest are
half its documentation.

`repoRoot()` falls back to `cwd` when there is no `.git`. Intentional: the tool
should work in a not-yet-initialized directory.

Templates are copied wholesale by `cpSync(TEMPLATES, dir, {recursive:true})`
except under `--minimal` and `--from`. Adding a template file automatically
ships it; the `MINIMAL` array in `init.js` is the only place needing a manual
update.

Single-line fields written into front matter are collapsed to one line first
(`line()` in generate.js). A newline in a generated `role` was once written raw
into a quoted scalar; the strict parser rejected it, `frontMatter` returned no
metadata, and the agent silently ran unscoped, non-terminal, at default
priority — claiming every file and never stopping to ask.

The ladder refuses to escalate into an agent that already spent its attempts.
Hand-written agents naming each other in a loop used to pass a task round
forever, each getting one more attempt past its limit. `/check` also reports the
loop up front via `escalationCycle()`.

In a numbered menu, an option that is only sometimes present goes LAST. The
per-agent model menu had "another model on the same key" in the middle; when
the model list was not loaded it vanished and every later option renumbered, so
the same keypress picked something different.

Test the prompter in TERMINAL mode (`test/terminal.test.js`, a fake TTY). Plain
streams put readline in non-terminal mode, a different code path, and every bug
a user hit at the keyboard lived in the part those tests never reached: a secret
prompt whose label was wiped by readline's redraw and whose echo was off, so it
looked dead; Ctrl+V arriving as a literal ^V in a raw Windows console; and a
second readline interface in `checkpoint()` that paused stdin when it closed,
leaving the chat deaf. There is ONE interface — the chat passes its prompter
down through `run()`. For a real console, drive `bin/jr-arch.js` under
`winpty -Xallow-non-tty -Xplain` with Enter sent as `\r`.

Some OpenAI-compatible servers ignore `stream: true` and answer JSON.
`postStream` checks the content type; before that, the body went to the SSE
parser, read as empty, and every task failed with "called no tool".

Chat reuses the current `jr-arch/session-*` branch. Without it every message cut
a new branch.

The prompter removes each question's `close` listener once it is answered.
Leaving them attached leaked one per prompt and Node printed a memory-leak
warning into the chat after eleven questions.

Do not edit JS containing backslashes through a Python heredoc with ordinary
string literals — a backslash-n or backslash-s gets halved into a real newline
or a bare letter, and it broke builds repeatedly while building phase 1. Use the
Edit tool, or Python raw strings. (This note was itself mangled that way the
first time it was written.)

A resumed run reuses the prior session's branch. Branching again would strand
the earlier attempts on a branch nobody looks at, which is the opposite of why
someone resumes.

The version is read from `package.json` at startup, never typed into
`bin/jr-arch.js`. The two drifted the first time the package was bumped, and
0.1.1 shipped reporting `--version 0.1.0`. npm always includes package.json in
the tarball, so the read works in an installed copy.

Boolean flags live in a `BOOLEAN` set in `bin/jr-arch.js`. Without it the
parser reads the next token as the flag's value, so `run --dry-run "add a
thing"` silently loses the task. A hand-rolled parser cannot infer arity — new
valueless flags must be added to that set.

`revertAttempt` runs `git clean -fd -e .gitagent/.session`. Without the
exclusion it deletes the run's own transcript in any repo whose `.gitignore`
does not yet mention the session directory.

Windows cannot spawn a `.cmd` shim without a shell (CVE-2024-27980), and
`shell: true` concatenates argv — the exact metacharacter surface `shell:false`
exists to remove. `resolveBin()` runs the shim through `cmd.exe` with an argv we
build, and refuses any token containing a character cmd would interpret.

`installPack()` and `packFiles()` share one SKIP/`.git` filter on purpose. If
they diverge, `.pack.lock` describes a set of files different from the one that
actually landed, and every later `pull` misreads the difference as a local edit.

## Related

Built on the [OpenGAP](https://www.gitagent.sh/) file layout so `.gitagent/`
stays portable to other GAP-compatible runtimes. Independent project, not
affiliated with the OpenGAP maintainers.

Sibling product: Jr Architect, the hosted browser IDE. This CLI is the local
terminal version — same personas, no sandbox infrastructure.

Two repos:
- CLI — `github.com/VivanRajath/content-orchestration-engine-service` (npm name
  is `jr-arch`; the repo name does not affect `npx`)
- Default pack — `github.com/VivanRajath/gitagent-default`, the four tiers as a
  standalone pack repo, installed with `init --from`

## Next

1. **A real task against a real model.** The loop, handoff reports, swarm and
   `/prompt` generation are all verified with scripted models only.
2. Publish 0.1.2 — the npm listing predates everything since 0.1.1, and 0.1.1
   ships with `--version` reporting 0.1.0.
3. Bring `gitagent-default` to the current format: its agents lack front-matter
   routing, and it still ships root SOUL.md/RULES.md.
4. `routing.entry` still names one agent.
5. Swarm does not escalate; ladder and swarm are two paths through `run()`.
6. `doctor` probes only the default key, not every name in `keyEnvs`.
7. Token accounting per agent and per model.
