# General Rules - Commit and PR

## Commit Message Format

- Use Conventional Commits: `<type>(<scope>): <subject>`
- Allowed `type` values: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- `scope`: module name (optional)
- Write the `subject` in concise imperative English

## Commit Execution Boundary

- Do not run `git add` or `git commit` directly. All automatic commits must use the shared `agent-infra-internal git-workflow commit` core and follow the paths, HEAD/tree, and delivery-mode constraints of the applicable skill.
- The active workflow defines whether a commit is required. Completing `code-task` requires a local checkpoint through the shared core after tests and report preflight pass. This applies to direct calls and `run-task` orchestration; no extra commit authorization or user confirmation is required.
- A `code-task` checkpoint never pushes to a remote. Other skills may call the shared core only when their workflow explicitly requires it. The standalone `commit` skill still requires an explicit user invocation and follows its push-delivery flow.
- Do not create a commit when the workflow does not require one. When a separate user commit is needed, remind the user to use the appropriate TUI command.

## PR Rules

Before creating a PR, make sure:
- all tests pass
- code checks pass
- the build succeeds
- public API documentation is updated when applicable
- copyright header years are updated when applicable

## Copyright Year Updates

- Run `date +%Y` first and do not hardcode the year
- Update examples:
  - `2024-2025` -> `2024-2026`
  - `2024` -> `2024-2026`
