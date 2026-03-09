---
description: Run integration tests (requires build first)
argument-hint:
---

# Integration Test Command

<!-- TODO: Replace with your project's actual integration test commands -->

## Description

Run the project's integration tests.

## Step 1: Verify Build Artifacts

```bash
# TODO: Replace with your project's build verification
# ls build/              (check build output exists)
# npm run build          (Node.js)
# mvn package -DskipTests  (Maven)
```

If build artifacts don't exist, prompt user to run test command first.

## Step 2: Run Integration Tests

```bash
# TODO: Replace with your project's integration test command
# npm run test:integration    (Node.js)
# mvn verify                  (Maven)
# pytest tests/integration/   (Python)
# go test -tags=integration ./...  (Go)
```

## Step 3: Output Results

Report test results:
- Tests run / passed / failed
- Environment issues (if any)
- Failure details (if any)

## Failure Handling

If tests fail:
- Output failure details
- Check for environment issues (ports in use, services not running, etc.)
- Do NOT auto-fix - wait for user decision

## Next Steps

After tests pass, commit code:
- Claude Code / OpenCode: /commit
- Gemini CLI: /{project}:commit
- Codex CLI: /prompts:{project}-commit

## Notes

1. **Prerequisites**: Usually requires a successful build first
2. **Environment**: Integration tests may require external services
3. **Timeouts**: Integration tests typically take longer
