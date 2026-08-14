# Common Rule - Lifecycle Orchestration

## Guarantee Boundary

- The orchestrator only routes and delegates. Stage skills remain the single source of truth for behavior and artifacts.
- Every stage and rework round uses a fresh executor. Every review uses a fresh reviewer; follow-up reuse is forbidden.
- A reviewer may only write its review artifact and core-generated task metadata. Business-code, HEAD, or index changes invalidate the receipt.
- An active run has one pending delegation. Missing, mismatched, forked, replayed, hook-less, or drifted evidence pauses the run.
- The first release ends after one existing safely gated `commit`; it does not create a PR, monitor checks, or complete the task.

## Recovery

`orchestration.json` is the detailed state source. A v2 run persists complete policy, source, and append-only recovery history. Only a v1 run with no pending delegation and zero receipts may be upgraded in place after supplying a complete policy; any historical receipt stays paused because effort is unverifiable. A historical Codex `ORCHESTRATION_CLIENT_UNSUPPORTED` v2 pause appends `CLIENT_CAPABILITY_ENABLED` and resumes only when step count, next stage, baseline, receipts, pending delegation, commit authorization, completion evidence, and commit intent all prove that execution never advanced; unknown or non-empty evidence preserves the pause. Migration is forward-only: old binaries must not advance active v2 runs.

## Model Policy

- A new run persists model and reasoning effort for both roles. Explicit policy is atomic across all four role fields; only a fully absent explicit policy may fall back to the current client's `agentClients[].orchestration`.
- Route resolves requested model/effort by role, and prepare matches both before snapshotting. Native spawn must not inherit session defaults.
- Native start records host-observed actual model/effort. Each mismatch needs its own fallback reason, and requested values must never be fabricated as actual evidence.
- Model selection is labeled as a complete catalog, partial catalog, or interactive-only guidance; a local override enum must not be presented as complete.

## Stable Pause Conditions

Human decisions, manual validation, handshake or step limits, permissions/network failures, worktree conflicts, unsupported client capability, and unknown hook schemas are persisted as pauses. The orchestrator must not ask mid-flow or degrade to same-context self-review.
