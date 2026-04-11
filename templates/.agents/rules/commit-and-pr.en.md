# General Rules - Commit and PR

## Commit Message Format

- Use Conventional Commits: `<type>(<scope>): <subject>`
- Allowed `type` values: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- `scope`: module name (optional)
- Write the `subject` in concise imperative English

## No Automatic Commits

- Never run `git commit` or `git add` automatically
- Enter the commit workflow only when the user explicitly requests a commit
- After finishing code changes, remind the user to use the appropriate TUI commit command

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
