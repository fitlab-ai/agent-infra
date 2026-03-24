# Implementation Rules

Read this file before coding or interpreting test failures.

## Execute Code Implementation

Follow the `implementation` step in `.agents/workflows/feature-development.yaml`.

**Required tasks**:
- [ ] implement the feature code according to the plan
- [ ] write comprehensive unit tests
- [ ] run tests locally to validate the feature
- [ ] update related documentation and comments
- [ ] follow project coding standards

**Implementation principles**:
1. **Follow the plan strictly**: do not deviate from the technical plan
2. **Work step by step**: execute the planned sequence
3. **Keep testing continuously**: re-run tests as work progresses
4. **Keep it simple**: do not add unplanned features

## Run Test Verification

Run the project test command. Refer to the `test` skill for project-specific commands.

```bash
# See .agents/skills/test/SKILL.md for the project's test command
# Common patterns:
# npm test          (Node.js)
# mvn test          (Maven)
# pytest            (Python)
# go test ./...     (Go)
```

If tests fail:
- analyze the failure first and prioritize fixing issues introduced by this implementation
- re-run tests after each fix until they pass, or confirm that the problem is an external blocker
- only stop without producing the implementation artifact when the failure is caused by an external blocker, missing environment, or unclear requirement that cannot be resolved inside the task

Two-way failure handling:
1. implementation-caused failures:
   - fix the code, tests, docs, or fixtures introduced by this implementation
   - re-run the test command after each fix
   - continue until all required tests pass
2. external blockers:
   - confirm the failure comes from missing environment, unrelated upstream breakage, or unclear requirements outside this task
   - stop without creating `implementation.md` / `implementation-r{N}.md`
   - do not mark implementation complete in `task.md`
   - do not output the normal success/next-step template

## Notes

1. **Prerequisite**: the approved technical plan must exist (`plan.md` or `plan-r{N}.md`)
2. **No auto-commit**: do not run `git commit` or `git add`
3. **Test quality**: new tests must validate meaningful business logic
4. **Code quality**: follow project coding conventions
5. **Plan deviation**: record any deviation in the implementation report
6. **Versioning**: Round 1 uses `implementation.md`; later rounds use `implementation-r{N}.md`
