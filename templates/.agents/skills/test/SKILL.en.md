---
name: test
description: "Run the full project test workflow"
---

# Run Tests

Execute the project's full test workflow including compilation checks and unit tests.

<!-- TODO: Replace the commands below with your project's actual commands -->

## 1. Compilation / Type Check

```bash
# TODO: Replace with your project's compilation command
# npx tsc --noEmit       (TypeScript)
# mvn compile             (Maven)
# go build ./...          (Go)
# make build              (generic)
```

Confirm no compilation errors.

## 2. Run Unit Tests by Layer

This project uses three test layers as an optional optimization; if the test suite is small, all layers may map to the same full test command.

### smoke (target <5s)

```bash
# TODO: Replace with this project's smoke subset command
# npm run test:smoke       (Node.js)
# pytest -m "not slow"     (Python)
# go test -short ./...     (Go)
```

Use for:
- implement-task / refine-task inner loops
- save-and-run / frequent feedback
- project structure, configuration, and template contract checks

### core (target <15s)

```bash
# TODO: Replace with this project's core subset command
# npm run test:core        (Node.js)
# pytest -m "not contract" (Python)
# go test ./...            (Go)
```

Use for:
- pre-commit hook (automatic)
- final verification before writing implementation.md / refinement.md
- local gate before pushing a PR

### full (complete test suite)

```bash
# TODO: Replace with this project's full test command
# npm test                 (Node.js)
# mvn test                 (Maven)
# pytest                   (Python)
# go test ./...            (Go)
```

Use for:
- before release / tag
- CI
- final gate before merging to main

If the project is not layered yet, smoke / core / full may all map to the same full test command; layering is a feedback-speed optimization, not a prerequisite for using the collaboration workflow.

## 3. Output Results

Report test result summary:
- Total tests run
- Passing count
- Failing count (with details for each failure)
- Test coverage (if configured)

## Failure Handling

If tests fail:
- Output failure details and suggested fix direction
- Do NOT auto-fix code - wait for user decision

## Next Steps

After tests pass, suggest committing the changes:

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

```
Next step - commit changes:
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /{{project}}:commit
  - Codex CLI: $commit
```
