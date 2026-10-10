# Implementation Rules

Read this file before coding or interpreting test failures.

## Execute Code Implementation

Follow the `code` step in `.agents/workflows/feature-development.yaml`.

**Required tasks**:
- [ ] implement the feature code according to the plan
- [ ] write comprehensive unit tests
- [ ] run tests locally to validate the feature
- [ ] update related documentation and comments
- [ ] follow project coding standards

**Implementation principles**:
1. **Follow the input strictly**: do not deviate from the analysis or plan lifecycle input selected by core
2. **Work step by step**: execute the planned sequence
3. **Keep testing continuously**: run the **fast smoke subset** continuously as work progresses (see the `test` skill)
4. **Keep it simple**: do not add unplanned features

## Strategy Pattern

Read `.agents/rules/strategy-pattern.md` before implementation. When behavior differs by platform, client, protocol, workflow, business rule, or algorithm, follow the interface selected in the plan and make the core flow depend on that interface rather than concrete classes. Add each behavior as a strategy and select or assemble it in one place. If branches identifying implementations are scattered across paths, centralize strategy selection before editing callers. Keep stable behavior direct when it has no meaningful alternatives; do not add interfaces mechanically.

## Run Test Verification

During implementation:
- **Inner loop**: after each change, run the project's **fast smoke subset** (see the `test` skill) for fast feedback without repeating the build
- **After each implementation step**: run the **smoke subset** to verify the complete build and unit tests
- **Before writing the code report**: run the **core subset** as final verification so code entering review has passed the complete core checks

> Refer to the `test` skill for project-specific commands; downstream projects without layered scripts should fall back to the full project test command.

If tests fail:
- analyze the failure first and prioritize fixing issues introduced by this implementation
- after each fix, re-run at least the fast smoke subset; after completing the implementation step, run smoke, then upgrade to core for the next full-pass verification
- only stop without producing the implementation artifact when the failure is caused by an external blocker, missing environment, or unclear requirement that cannot be resolved inside the task

Two-way failure handling:
1. implementation-caused failures:
   - fix the code, tests, docs, or fixtures introduced by this implementation
   - re-run tests after each fix (fast smoke for the immediate fix verification, smoke for complete-build verification, core for the round-level verification)
   - continue until all required tests pass
2. external blockers:
   - confirm the failure comes from missing environment, unrelated upstream breakage, or unclear requirements outside this task
   - stop without creating `code.md` / `code-r{N}.md`
   - do not mark code complete in `task.md`
   - do not output the normal success/next-step template

## Notes

1. **Prerequisite**: the analysis or plan lifecycle input selected by core must exist
2. **Local checkpoint**: after report preflight passes, `code-task` must create a local checkpoint through the shared commit core; do not run `git commit` or `git add` directly
3. **Test quality**: new tests must validate meaningful business logic
4. **Code quality**: follow project coding conventions
5. **Plan deviation**: record any deviation in the code report
6. **Versioning**: Round 1 uses `code.md`; later rounds use `code-r{N}.md`
