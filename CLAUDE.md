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
src/personas.js         list / add / remove tiers, --from <git-url> pull
src/doctor.js           model capability probe (structured output + tool calling)
src/paths.js            repoRoot() walks up to .git; TEMPLATES resolution
src/util.js             color + log helpers
templates/              everything copied into the user's .gitagent/
```

## Status

Working and manually tested: `init`, `config`, `config set`, `personas list|add|remove`,
`doctor`, help, and the error paths (existing dir, unknown provider).

Not built yet: the execution loop. Nothing reads `.gitagent/` and actually runs the
agent. That is the next piece — classify task, select tier, call model, apply diff
with hooks enforced, escalate per `DUTIES.md`.

No test suite yet. Worth adding around `init` and the manifest patcher first.

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

**`doctor` fails at setup, not mid-task.** The tier ladder needs strict JSON and
tool calling. Small local models often give neither and the ladder degrades into
retry thrash that reads as a bug in this tool. Probe, then tell the user to drop
to single-tier if it won't hold.

## Gotchas

`agent.yaml` has `name:` under **both** `metadata:` and `model:`. A file-wide
regex replace clobbers the wrong one — this bug already happened once. `init.js`
scopes the patch to the `model:` block. Any new manifest edit must do the same.

`readManifest()` in `config.js` is a deliberately minimal section-scoped reader,
not a YAML parser. If manifest handling gets more complex, add a real parser
rather than extending the regexes — but that costs the zero-dep property, so
weigh it.

`repoRoot()` falls back to `cwd` when there is no `.git`. Intentional: the tool
should work in a not-yet-initialized directory.

Templates are copied wholesale by `cpSync(TEMPLATES, dir, {recursive:true})`
except under `--minimal`. Adding a template file automatically ships it; the
`MINIMAL` array in `init.js` is the only place needing a manual update.

## Related

Built on the [OpenGAP](https://www.gitagent.sh/) file layout so `.gitagent/`
stays portable to other GAP-compatible runtimes. Independent project, not
affiliated with the OpenGAP maintainers.

Sibling product: Jr Architect, the hosted browser IDE. This CLI is the local
terminal version — same personas, no sandbox infrastructure.

## Next

1. Execution loop (`src/run.js`) — the missing half.
2. Hook enforcement engine — parse `hooks.yaml`, apply pre-edit/pre-commit gates.
3. Tier classifier — one cheap model call returning `{tier, confidence, reason}`;
   below `classifier_confidence_floor`, route one tier up.
4. Tests around `init` and the manifest patcher.
5. Stack detection, ported from `sandbox-engine-cli`, as `jr-architect detect`.
