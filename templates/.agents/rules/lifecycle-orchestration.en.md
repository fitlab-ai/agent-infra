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

- Model policy is optional. Hosts that can supply model evidence may persist executor/reviewer models (distinct models require a null `sameModelReason`; using one model for both roles requires an isolation-limit reason). Hosts that cannot report an actual model (e.g. Claude Code) may omit the policy and run without one. Re-entry must not silently rewrite a persisted policy.
- With a model policy, route resolves the requested model by role, prepare matches it before a workspace snapshot, and native spawn explicitly uses it instead of inheriting session defaults.
- When native start reports an actual model, core records it. A requested/actual mismatch separately requires `modelFallbackReason`; the same-model policy reason cannot substitute for it. A host that does not report an actual model is a valid state, not a fail-closed condition.
- Missing model policy or actual model no longer fails closed. A legacy run without model policy may continue normally.

## Stable Pause Conditions

Human decisions, manual validation, handshake or step limits, permissions/network failures, worktree conflicts, unsupported client capability, and unknown hook schemas are persisted as pauses. The orchestrator must not ask mid-flow or degrade to same-context self-review.
