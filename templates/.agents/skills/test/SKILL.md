---
name: test
description: >
  Execute the project's full test workflow (compilation check + unit tests).
  Triggered when the user requests running tests or verifying code quality.
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

## 2. Run All Unit Tests

```bash
# TODO: Replace with your project's test command
# npm test                (Node.js)
# mvn test                (Maven)
# pytest                  (Python)
# go test ./...           (Go)
```

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

After tests pass, suggest committing the changes.
