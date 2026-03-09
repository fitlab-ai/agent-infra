---
name: "test-integration"
description: "Run integration test workflow"
usage: "/test-integration"
---

# Integration Test Command

## Description

Run the project's integration tests.

<!-- TODO: Replace the commands below with your project's actual commands -->

## Step 1: Verify Build Artifacts

Ensure the project has been built before running integration tests.

```bash
# TODO: Replace with your project's build verification
# ls build/              (check build output exists)
# npm run build          (Node.js)
# mvn package -DskipTests  (Maven)
```

If build artifacts don't exist, prompt user to run `/test` first.

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

After tests pass, commit code using:
- Claude Code / OpenCode: `/commit`
- Gemini CLI: `/{project}:commit`
- Codex CLI: `/prompts:{project}-commit`

## Notes

1. **Prerequisites**: Usually requires a successful build first (run `/test`)
2. **Environment**: Integration tests may require external services (databases, APIs, etc.)
3. **Timeouts**: Integration tests typically take longer; be patient
4. **Cleanup**: Ensure test environment is cleaned up after tests complete
