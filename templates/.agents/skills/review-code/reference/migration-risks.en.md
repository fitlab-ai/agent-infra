# Migration and Compatibility Risk Review

## Scope

Use when changes touch persistent formats, schemas, configuration/frontmatter, compatibility reads, migrations, or rollback behavior.

## Review Questions

- Can old data or configuration be read safely, and is the post-write version boundary explicit?
- Is migration repeatable, and can execution recover or continue after partial failure?
- Does the rollback path match the compatibility window between old and new formats?

## Evidence Requirements

Record the transition from old input to new state, version decisions, and failure states. Prefer migration tests, fixtures, state transitions, or specification conflicts.

## Common Counterexamples

- Testing only fresh installation and ignoring existing state.
- Assuming migration succeeds once while ignoring retries and partial writes.
- Replacing data-semantic validation with format-existence checks.

## When Closure Is Not Possible

Record reproducible corruption or compatibility failures as findings, checks requiring real historical data as manual-validation, and missing samples or rollback evidence as a gap.
