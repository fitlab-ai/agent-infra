---
name: test-integration
description: "Run the integration test workflow"
---

# Run Integration Tests

Execute the project's integration test workflow for end-to-end verification.

<!-- TODO: Replace the commands below with your project's actual commands -->

## 1. Verify Build Artifacts

Ensure the project has been built before running integration tests.

```bash
# TODO: Replace with your project's build verification
# ls build/              (check build output exists)
# npm run build          (Node.js)
# mvn package -DskipTests  (Maven)
```

If build artifacts don't exist, prompt user to run the test skill first.

## 2. Run Integration Tests

```bash
# TODO: Replace with your project's integration test command
# npm run test:integration    (Node.js)
# mvn verify                  (Maven)
# pytest tests/integration/   (Python)
# go test -tags=integration ./...  (Go)
```

## 3. Output Results

Report results:
- Tests run / passed / failed
- Environment issues (if any)
- Failure details (if any)

## Failure Handling

If tests fail:
- Output failure details
- Check for environment issues (ports in use, services not running, etc.)
- Do NOT auto-fix - wait for user decision

## Next Steps

After tests pass, suggest committing the changes:

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures `customTools`, read each tool's `name` and `invoke`, then add the matching command line in the same format (`{name}` becomes the skill name and `&#123;project&#125;` becomes the project name).

```
Next step - commit changes:
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /{{project}}:commit
  - Codex CLI: $commit
```

## Notes

1. **Prerequisites**: Usually requires a successful build first (run the test skill)
2. **Environment**: Integration tests may require external services (databases, APIs, etc.)
3. **Timeouts**: Integration tests typically take longer; be patient
4. **Cleanup**: Ensure test environment is cleaned up after tests complete
