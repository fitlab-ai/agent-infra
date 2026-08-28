# Migration and Compatibility Risk Review

## Scope

Use when changes touch persistent formats, schemas, configuration/frontmatter, compatibility reads, migrations, or rollback behavior.

## Review Questions

- Does compatibility pass the subject, necessity, window, and exit gate in `.agents/rules/compatibility-policy.md`? If not, should the change be current-only?
- Is an approved conversion concentrated at one boundary and followed by current-format-only writes, rather than teaching business logic multiple versions?
- If migration is required, is it repeatable, and can partial failure recover or stop safely?
- When an old format is removed, are its branches, fixtures, tests, and documentation removed in the same change?

## Evidence Requirements

Record compatibility admission evidence first. For approved compatibility, record the single conversion from old input to current state, version decisions, exit condition, and failure states. Prefer consumer or stored-data evidence, migration tests, fixtures, state transitions, or specification conflicts.

## Common Counterexamples

- Retaining an old read path “just in case” without real consumers or stored data.
- Dual-writing formats or maintaining several state machines in the normal path.
- Assuming migration succeeds once while ignoring retries and partial writes.
- Replacing data-semantic validation with format-existence checks.

## When Closure Is Not Possible

Record unauthorized compatibility, dual writes, and shims without an exit condition as findings. For approved migrations, record reproducible corruption as a finding and checks requiring real historical data as manual-validation. Missing compatibility admission evidence cannot be treated as a harmless gap while approving the change.
