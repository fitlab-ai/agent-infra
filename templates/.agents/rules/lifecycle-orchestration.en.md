# Common Rule - Lifecycle Orchestration

## Guarantee Boundary

- The orchestrator only routes and delegates. Stage skills remain the single source of truth for behavior and artifacts.
- Every stage and rework round uses a fresh executor. Every review uses a fresh reviewer; follow-up reuse is forbidden.
- A reviewer may only write its review artifact and core-generated task metadata. Business-code, HEAD, or index changes invalidate the receipt.
- An active run has one pending delegation. Keep the stage associated with the observed child and report actual start and terminal failures.
- The first release ends after one existing safely gated `commit`; it does not create a PR, monitor checks, or complete the task.

## Current Execution Records

`orchestration.json` records stages, model policy, child identity, and actual outcomes. Records use the current structure; trusted local operators may correct them and rerun validation. Existing task write locks and atomic writes protect updates.

## Codex Host

- Use native spawn, wait, and App Server results from the current host; forward task operations through the existing broker.
- Prepare validates the current task, model policy, and host preflight. Start and terminal records associate observed parent/child identity; failure must not be recorded as success.
- Local execution does not require capability, controller attestation, or one-use consumption authority. Do not add automatic child discovery, spawn under a new lock protocol, orphan recovery, or a dedicated recovery protocol.

## Model Policy

- A new run persists model and reasoning effort for both roles. Explicit policy is atomic across all four role fields; only a fully absent explicit policy may fall back to the current client's `agentClients[].orchestration`.
- Route resolves requested model/effort by role, and prepare matches both before snapshotting. Native spawn must not inherit session defaults.
- Native start records host-observed actual model/effort. Each mismatch needs its own fallback reason (the claude-code path may leave this blank and follow the recording rules instead), and requested values must never be fabricated as actual evidence.
- Model selection is labeled as a complete catalog, partial catalog, or interactive-only guidance; a local override enum must not be presented as complete.
- claude-code's requested reasoning effort does not yet support per-role dispatch (concurrent tasks would race on a shared file); `delegationEvidence.actualReasoningEffort` is declared `spawn-ack`, meaning it is only recorded when honestly observed in a native spawn lifecycle event (Start/Stop) — it is not a promise of per-role dispatch and does not gate activation.

## Stable Pause Conditions

Human decisions, manual validation, handshake or step limits, permissions/network failures, worktree conflicts, unsupported client capability, and unknown hook schemas are persisted as pauses. The orchestrator must not ask mid-flow or degrade to same-context self-review.
