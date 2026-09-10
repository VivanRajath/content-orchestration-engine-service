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

Working, tested: `init` (bundled and `--from <git-url>`), `pull`, `config`,
`config set`, `personas list|add|remove`, `doctor`, the guardrail engine, the
tier classifier, and the error paths. `node --test`, 180 tests, no runner.

`run` drives the full ladder: classify, attempt, block, hand off, nest
build-doctor, verify, commit to a session branch, streaming its output.
`run --resume` continues a stopped session on its original branch. `detect`
reports the stack. `personas add|remove` wires the tier into agent.yaml and
DUTIES.md rather than telling the user to. 291 tests, `node --test`.

Not yet exercised against a live model — the ladder is tested with an injected
scripted model, not a real one. Whoever has a key first should run it on a
throwaway repo before trusting it on anything else.

## Decisions already made — do not relitigate without reason

**Keys never land in `agent.yaml`.** The manifest stores an env var *name*
(`api_key_env`), never a key. `init` appends `.gitagent/.env` to `.gitignore`.
The privacy pitch dies the first time a user commits a key.

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

**Streaming stops retrying at the first byte.** `post` can safely replay a
request that never produced a response; `postStream` cannot, because tokens
already handed to the caller are already on the user's screen. A mid-stream
failure is an error, not a retry.

**`--resume` is not a conversation replay.** The message history is never
stored — doing so would write every prompt and tool result into the user's
repo. A resume rebuilds the same brief a handoff carries: the original task,
the tier history, and the failed diffs. That is what DUTIES.md already says an
escalation needs, so a resumed tier reads its history in a format it knows.

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

`personas` patches the DUTIES.md tier table scoped to the `## Tiers` section.
The tier name also appears in the escalation prose below it, and a file-wide
replace would rewrite the sentences defining the handoff graph — the
`metadata:`/`model:` bug again, in a different file.

A resumed run reuses the prior session's branch. Branching again would strand
the earlier attempts on a branch nobody looks at, which is the opposite of why
someone resumes.

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

1. A live-model run on a throwaway repo. Everything below is speculation until
   that happens.
2. `run --resume <session-id>`, using the transcript already being written.
4. Stack detection, ported from `sandbox-engine-cli`, as `jr-arch detect`.
5. `personas add` should offer to patch `agent.yaml` and `DUTIES.md` rather than
   printing a reminder to do it by hand.
