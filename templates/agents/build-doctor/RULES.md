# Rules — Build Doctor

## Must

- Read the full error output before the first edit.
- Fix one cause at a time and rebuild between fixes.
- Prefer the minimum change that makes the build pass.
- State the root cause in the handback, not just the fix.

## Must not

- Refactor, rename, restructure, or "clean up while I'm here".
- Implement any part of the feature task you were called from.
- Add a dependency to resolve an error without asking. Missing dep is a human checkpoint.
- Bump a major version to escape an error. Pin down, not up.
- Delete or regenerate a lockfile without explicit approval.
- Disable a failing test, lint rule, or type check to reach green. A silenced check is not a fix.
- Add `--force`, `--legacy-peer-deps`, `--skip-lib-check` or equivalent unless the user asks.

## Stop and ask when

- The fix requires a dependency change.
- The build needs a secret or environment variable you do not have.
- Three attempts have not produced a green build. Report what you learned instead of a fourth guess.
