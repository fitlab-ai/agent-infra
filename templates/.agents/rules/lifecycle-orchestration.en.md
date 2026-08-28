# Common Rule - Lifecycle Orchestration

## Guarantee Boundary

- The orchestrator only routes and delegates. Stage skills remain the single source of truth for behavior and artifacts.
- Every stage and rework round uses a fresh executor. Every review uses a fresh reviewer; follow-up reuse is forbidden.
- A reviewer may only write its review artifact and core-generated task metadata. Business-code, HEAD, or index changes invalidate the receipt.
- An active run has one pending delegation. The child must pass the activation barrier before any stage side effect. Missing, late, mismatched, forked, replayed, hook-less, or drifted evidence pauses the run (on the claude-code path, missing or mismatched model/effort evidence, and fork/spawn-mode evidence this host structurally does not provide, follow the recording rules in `.agents/skills/run-task/reference/host-validation.md` instead and are exempt from this; missing or mismatched `parentId`/`childId` still pauses). Cross-root package/build/contract or hook/profile content drift is a deliverable warning; the current receipt's hook/evidence binding remains hard.
- The first release ends after one existing safely gated `commit`; it does not create a PR, monitor checks, or complete the task.

## Recovery

`orchestration.json` is the detailed state source. A current run persists complete policy, append-only recovery, build/contract/hook-source/controller provenance, and activation monotonic timestamps. Readers accept only the complete structure emitted by the current writer; unknown fields, missing fields, invalid provenance, and old runs fail closed without rewriting. If the state cannot be recognized, preserve the file, advise rebuilding the sandbox or manually repairing it, do not migrate it, and do not create a follow-up task. Finish or clear every active run before upgrading agent-infra. An expired prepared orphan may be explicitly recovered only with the exact task fingerprint, no consumed authorization, and no matching unconsumed active lifecycle evidence.

## Codex Host and Capability

- Direct-host accepts only trusted project or managed lifecycle hooks. A task-bound sandbox requires a controlled nested controller and isolated `CODEX_HOME`; only user hooks bound to that controller context are accepted. Ordinary user/plugin hooks are not evidence. The actual hook/profile used by the run is the source of record; content drift is reported as a warning with rebuild guidance.
- The controller starts a nested loop only after control generation, task binding, protocol version, profiles, and hook discovery pass. Build/contract and content drift is reported as a structured warning with rebuild guidance instead of blocking natural evolution. Both bypass flags are restricted to this task-bound launch path.
- Every prepare arms a one-use capability attested by the current loop's real PostToolUse. Atomic consumption binds task/session/build/controller and retains only a redacted tombstone.

## Model Policy

- A new run persists model and reasoning effort for both roles. Explicit policy is atomic across all four role fields; only a fully absent explicit policy may fall back to the current client's `agentClients[].orchestration`.
- Route resolves requested model/effort by role, and prepare matches both before snapshotting. Native spawn must not inherit session defaults.
- Native start records host-observed actual model/effort. Each mismatch needs its own fallback reason (the claude-code path may leave this blank and follow the recording rules instead), and requested values must never be fabricated as actual evidence.
- Model selection is labeled as a complete catalog, partial catalog, or interactive-only guidance; a local override enum must not be presented as complete.
- claude-code's requested reasoning effort does not yet support per-role dispatch (concurrent tasks would race on a shared file); `delegationEvidence.actualReasoningEffort` is declared `spawn-ack`, meaning it is only recorded when honestly observed in a native spawn lifecycle event (Start/Stop) — it is not a promise of per-role dispatch and does not gate activation.

## Stable Pause Conditions

Human decisions, manual validation, handshake or step limits, permissions/network failures, worktree conflicts, unsupported client capability, and unknown hook schemas are persisted as pauses. The orchestrator must not ask mid-flow or degrade to same-context self-review.
