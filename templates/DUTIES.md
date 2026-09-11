# Duties and Escalation

Who picks up a task, who they hand it to, and what travels with the handoff.

**This file is a default, not a requirement.** It describes the four agents
this scaffold happens to ship with. Delete it, rewrite it, or replace it the
moment your set of agents stops looking like this one — the loop reads whatever
is here and passes it to every agent, and reads nothing at all if the file is
gone. What each agent owns and when it hands off is really declared in its own
`SOUL.md` and `RULES.md`; this file exists so the agents agree on one story.

What is NOT optional, and is not in this file: `hooks/`. Those are enforced by
the harness whatever any agent believes.

## Agents

| Tier | Owns | Never does |
|---|---|---|
| `build-doctor` | Getting the build green | Feature work, refactors, design decisions |
| `junior-dev` | Scoped single-concern changes | Cross-cutting edits, dependency changes, schema changes |
| `senior-dev` | Architectural and multi-file work | Silent scope expansion without a stated plan |
| `ui-editor` | Presentational layer only | Business logic, data fetching, state architecture |

## Entry

Entry agent is chosen from repo state and task shape, never from language or
framework. Priority order comes from each agent's own front matter.

1. Build fails, dependencies missing, or no lockfile → `build-doctor`. Nothing else runs until the build is green.
2. Task is presentational (styling, layout, copy, component markup) → `ui-editor`.
3. Task is single-concern, well-specified, bounded to roughly one file → `junior-dev`.
4. Task is cross-cutting, ambiguous, or touches more than three files → `senior-dev`.

Classification returns strict JSON: `{tier, confidence, reason}`. Below the
confidence floor, route one step higher. Over-qualifying costs tokens;
under-qualifying costs a thrash loop and the user's trust.

## Escalation

- **`junior-dev` fails twice** → `senior-dev`. Both failed diffs travel with the handoff, plus the error output. Without them the senior repeats the junior's first attempt.
- **`ui-editor` reaches non-presentational code** → `junior-dev`. Stop at the boundary, do not "just quickly" edit the handler.
- **Any tier hits a build error** → `build-doctor`, then resume the *original* tier at the *same step*. Build doctor returns control; it does not inherit the task.
- **`senior-dev` fails twice** → stop and escalate to the human. Senior is terminal. There is no tier above it, and looping is worse than asking.

## Handoff payload

Every handoff carries, at minimum:

- original task text, unmodified
- tier history with attempt counts
- diffs already attempted, including reverted ones
- last build or test output
- the specific reason for the handoff

Truncate file contents before truncating this. An escalation without failure
context is just a slower retry.

## Human checkpoints

Always stop and ask, regardless of tier:

- dependency added, removed, or version-bumped
- database schema or migration touched
- auth, permissions, or crypto touched
- more than `diff_line_ceiling` lines in a single edit
- anything under `hooks/hooks.yaml` protected paths
