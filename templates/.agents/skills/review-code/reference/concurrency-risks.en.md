# Concurrency Risk Review

## Scope

Use when changes touch asynchronous coordination, shared state, locks, retries, idempotency, races, cancellation, or timeouts.

## Review Questions

- Are shared-state ownership, atomic boundaries, and visibility explicit?
- Do retries, timeouts, cancellation, and duplicate delivery remain idempotent and resource-safe?
- Can competing order or failure interleavings cause lost updates, duplicate side effects, or deadlocks?

## Evidence Requirements

Record key state transitions, event order, and synchronization boundaries. Support conclusions with deterministic concurrency tests, call chains, or data flows.

## Common Counterexamples

- Inferring concurrency safety from one successful sequential execution.
- Checking only that a lock exists without its granularity, ordering, and release paths.
- Replacing explainable evidence with one successful randomized stress run.

## When Closure Is Not Possible

Record reproducible races or leaks as findings, checks requiring a real scheduler or load environment as manual-validation, and uncovered interleavings as a gap.
