# jr-architect

CLI that scaffolds a GAP-format `.gitagent/` folder into a user's repo, pre-filled
with four coding personas and guardrails. Bring-your-own model and key.

Node, ESM, **zero runtime dependencies**. Keep it that way — `npx` speed is a
feature, and arg parsing is hand-rolled in `bin/jr-architect.js` on purpose.

## Layout

```
bin/jr-architect.js     entry, arg parsing, command dispatch
src/init.js             scaffold .gitagent/, patch agent.yaml, guard .gitignore
src/config.js           read/write manifest; readManifest() is the shared reader
src/pack.js             fetch / validate / install an agent pack from a git repo
src/pull.js             update an installed pack, merging against .pack.lock
src/personas.js         list / add / remove tiers, --from <git-url> pull
src/hooks.js            guardrail engine; sealed hooks live here, not in yaml
src/classify.js         one model call -> {tier, confidence, reason}
src/provider.js         anthropic + openai wire formats, key redaction
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

Not built yet: **the execution loop**. Nothing reads `.gitagent/` and actually
runs the agent. Everything it needs now exists — `classify.js` picks the tier,
`hooks.js` gates edits and commands, `provider.js` talks to the model — and
`src/run.js` is the piece that drives them.

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
  is `jr-architect`; the repo name does not affect `npx`)
- Default pack — `github.com/VivanRajath/gitagent-default`, the four tiers as a
  standalone pack repo, installed with `init --from`

## Next

1. Execution loop (`src/run.js`) — the missing half. Classify, select tier, call
   model, apply diff with hooks enforced, escalate per `DUTIES.md`.
2. Session branch + transcript under `.gitagent/.session/` (already gitignored).
3. Stack detection, ported from `sandbox-engine-cli`, as `jr-architect detect`.
4. `personas add` should offer to patch `agent.yaml` and `DUTIES.md` rather than
   printing a reminder to do it by hand.
