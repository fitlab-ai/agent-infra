---
name: test
description: >
  Run the full project test workflow.
  Use when you need to run the project's full test suite.
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

### fast smoke (target <5s)

```bash
# TODO: Replace with this project's fast smoke subset command
# npm run test:smoke:fast       (Node.js)
# pytest -m "not slow"          (Python)
# go test -short ./...          (Go)
```

Use for code-task inner loops when the project provides a build-free fast path. It should cover the same tests as smoke while skipping redundant compilation or generation.

### smoke (target <5s)

```bash
# TODO: Replace with this project's smoke subset command
# npm run test:smoke       (Node.js)
# pytest -m "not slow"     (Python)
# go test -short ./...     (Go)
```

Use for:
- after completing an implementation step
- save-and-run / frequent feedback when no fast path exists
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
- final verification before writing code.md / code-r{N}.md
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

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill commit`.

```
Next step - commit changes:
{next-step-commands}
```
