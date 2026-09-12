# Duties

How agents hand work to each other. Every installed agent is given this file,
so it is where they agree on the protocol.

**No agent is named here, on purpose.** Which agents exist, what each one owns,
and who it hands to are declared by the agents themselves, in the front matter
of their own `SOUL.md`:

```yaml
---
name: reviewer
role: Reviews diffs before they land
priority: 20              # lower numbers claim work first
owns: ["**/*.test.js"]    # globs it claims; omit to claim anything
parallel: true            # may run beside agents with non-overlapping scope
escalates_to: architect   # who takes over when it runs out of attempts
# terminal: true          # instead: stop and ask the human
---
```

Edit this file freely, or delete it. The loop passes whatever is here and
passes nothing when it is gone. What is **not** optional, and is not in this
file, is `hooks/` — those are enforced by the harness whatever any agent
believes about them.

## Entry

The first agent is chosen from repo state and the shape of the task, never from
the language or framework the repo is written in. A CSS change in a Go repo is
still presentational work.

1. If the build is red, the lowest-priority agent that repairs builds takes it,
   and nothing else runs until it is green.
2. Otherwise the task goes to the agent whose declared scope covers it, lowest
   `priority` first.
3. A task no agent's scope covers goes to the agent with no scope, or failing
   that, to the last agent by priority.

Classification returns strict JSON: `{tier, confidence, reason}`. Below
`classifier_confidence_floor`, the task is routed one step up — to whatever the
classified agent declares as its successor. Over-qualifying costs tokens;
under-qualifying costs a thrash loop and the user's trust.

## Escalation

An agent hands off in one of two ways.

**Sideways, immediately** — by calling `handoff()` the moment the task turns out
not to be its job. This is the design working, not a failure. Stop at the
boundary rather than "just quickly" reaching past it.

**Upward, on exhaustion** — when it has used its attempts. The successor is
whatever the agent's `escalates_to` names, or the next agent by priority. An
agent declaring `terminal: true` has nobody above it: it stops and reports to
the human, because looping is worse than asking.

A delegated agent returns control rather than inheriting the task. An agent
called in to fix something for another agent finishes that job and hands back
at the same step; it does not continue into work it was not given.

## What travels with a handoff

The harness compiles this and the successor may be a different model from a
different provider, so it is a record rather than a transcript:

- the original task, unmodified
- the decisions made so far, with the reason for each
- the files the harness actually saw written
- open issues
- approaches already tried and ruled out
- the single most useful next action

Failed approaches are append-only. No later agent can remove one, because a
successor that cannot see what failed will try it again.

Anything the harness did not observe itself is marked as the agent's claim
rather than as fact. Naming a file in prose is not evidence it was written.

## Human checkpoints

Always stop and ask, whichever agent is acting:

- a dependency added, removed, or version-bumped
- a database schema or migration touched
- auth, permissions, or cryptographic code touched
- more than `diff_line_ceiling` lines in a single edit
- anything matching a protected path in `hooks/`
