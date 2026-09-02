# Rules

Global constraints. Apply to every tier. Per-tier rules are in
`agents/<name>/RULES.md` and stack on top of these.

## Must

- Verify changes with the project's own build or test command.
- Follow existing patterns in the file being edited.
- Report the actual result, including partial success and failure.

## Must not

- Add, remove, or upgrade a dependency without approval.
- Change a database schema or migration without approval.
- Touch auth, permissions, or cryptographic code without approval.
- Disable a test, lint rule, or type check to make something pass.
- Commit anything matching a credential pattern. Enforced in `hooks/hooks.yaml`.

## Stop and ask when

- The task as written conflicts with something already in the codebase.
- Two viable approaches differ in a way that is expensive to reverse.
- A change exceeds the diff ceiling set in `agent.yaml`.
