# Common Rule - Testing Discipline

> This file carries detailed examples for test-writing discipline. AGENTS.md (and CLAUDE.md) keep only concise testing rules and point here to avoid inflating high-frequency context.

## Background

A batch of fragile keyword-matching assertions once had to be replaced with structural checks (valid frontmatter, step numbering, reference integrity, zh-CN variants, and size thresholds). Lesson: binding tests to natural-language wording, or using assertions to "remember a deleted concept", creates endless test debt.

## Example: do not add negative assertions when a positive assertion already covers the behavior

When a positive assertion already covers the expected behavior, do not add another negative assertion for "the opposite should not appear".

Bad:
```ts
assert.match(content, /^name: implement-task$/m);    // The positive assertion already covers the expected value.
assert.doesNotMatch(content, /^name: wrong-name$/m); // Redundant: permanently remembers a value that should not appear.
```

Good:
```ts
assert.match(content, /^name: implement-task$/m);    // The positive assertion is enough.
```

If the positive assertion passes, the value is correct. The extra negative assertion adds no protection, only maintenance cost, and can become a test that permanently remembers a concept after the feature is gone.

## RED-GREEN-REFACTOR rhythm

During implementation, turn the requirement into a test for observable behavior before writing the code:

1. **RED**: First write a failing test that reproduces the requirement or defect, and confirm that it really fails. The test should cover business behavior, inputs and outputs, or user-visible results, not internal implementation details.
2. **GREEN**: Write the smallest amount of code needed to make the failing test pass. Do not expand behavior that is not covered by the test or the requirement.
3. **REFACTOR**: After the tests are green, clean up names, structure, or duplication; keep the same test set passing before and after the refactor.

This mirrors "Goal-Driven Execution" in AGENTS.md: define a verifiable success criterion first, then make the implementation satisfy it.

## Test anti-patterns

- **Over-mocking**: Stub only real boundaries such as network, filesystem, time, or randomness; do not mock the logic of the unit under test, or the test only proves that the mock followed the script.
- **Testing implementation details**: Prefer assertions on public APIs, artifacts, state changes, or error results; avoid assertions on private functions, internal call order, or temporary data structures.
- **Insufficient assertions**: Assertions must pin down concrete expected values; do not replace checks on key fields, counts, and boundaries with "does not throw" or "result exists".
