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
