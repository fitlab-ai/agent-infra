---
description: Run full test workflow
argument-hint:
---

# Test Command

<!-- TODO: Replace with your project's actual test commands -->

## Description

Run the project's full test workflow.

## Step 1: Compilation / Type Check

```bash
# TODO: Replace with your project's compilation command
# npx tsc --noEmit       (TypeScript)
# mvn compile             (Maven)
# go build ./...          (Go)
# make build              (generic)
```

## Step 2: Run All Unit Tests

```bash
# TODO: Replace with your project's test command
# npm test                (Node.js)
# mvn test                (Maven)
# pytest                  (Python)
# go test ./...           (Go)
```

## Step 3: Output Results

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

After tests pass, commit code:
- Claude Code / OpenCode: /commit
- Gemini CLI: /{project}:commit
- Codex CLI: /prompts:{project}-commit
