# Common Rule - Lifecycle Orchestration

## Guarantee Boundary

- The orchestrator only routes and delegates. Stage skills remain the single source of truth for behavior and artifacts.
- Every stage and rework round uses a fresh executor. Every review uses a fresh reviewer; follow-up reuse is forbidden.
- A reviewer may only write its review artifact and core-generated task metadata. Business-code, HEAD, or index changes invalidate the receipt.
- An active run has one pending delegation. Missing, mismatched, forked, replayed, hook-less, or drifted evidence pauses the run.
- The first release ends after one existing safely gated `commit`; it does not create a PR, monitor checks, or complete the task.

## Recovery

`orchestration.json` is the detailed state source. Re-entry reconciles first: completed runs return idempotently; recoverable pauses continue only after the blocker clears; unproven children, unsealed receipts, and baseline drift stay paused. Reviewer identities are never reused.

## Model Policy

Prefer a reviewer model different from the preceding executor. Same-model fallback must record requested model, actual model, and reason; an unrecorded fallback fails closed.

## Stable Pause Conditions

Human decisions, manual validation, handshake or step limits, permissions/network failures, worktree conflicts, unsupported client capability, and unknown hook schemas are persisted as pauses. The orchestrator must not ask mid-flow or degrade to same-context self-review.

