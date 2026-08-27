---
name: run-task
description: >
  Orchestrate lifecycle stages from the task's current state with fresh executors/reviewers and one-use provenance receipts.
  Use when one entry should advance an existing task until a safe commit or stable pause.
---

# Run Task Lifecycle

The orchestrator delegates only and never executes a stage skill itself. First read `.agents/rules/no-mid-flow-questions.md`, `.agents/rules/lifecycle-orchestration.md`, and `reference/host-validation.md`.

1. Resolve the canonical task ID, current Agent Client, and optional atomic policy flags, then run `task-snapshot`. If one explicit role field is present, all four are required.
2. Before `begin-or-resume`, Codex selects a host. Without `AGENT_INFRA_CONTROL_TOKEN`, use direct-host. With task-bound control authority but no `AGENT_INFRA_CODEX_CONTROLLER_CONTEXT`, only run `codex-sandbox-controller run` with the complete policy and wait; the outer loop must not create a run, baseline, or receipt. With a context, run `verify-context` first. Stop on protocol, task/controller/process, lease, or source/profile discovery failures. Package/build/contract or hook/profile content drift is delivered as a structured warning with rebuild guidance.
3. Run `task-orchestration {task-id} begin-or-resume --client {client}` with the complete explicit policy. With no explicit policy, core reads that client's configured policy; existing runs use persisted policy. Disk state outside the complete current structure fails closed without rewriting; finish or clear active runs before upgrading. Stop on paused/completed results.
4. Run `route`. On `completed`, run `agent-infra-internal task-verify {task-id} run-task.completed --format text` and stop. Only a `running` result with non-null `next` supplies action, role, round, artifact, requested model, and requested effort.
5. Codex runs `codex-lifecycle capability-arm --task-id {task-id}` once. The current loop's real PostToolUse must attest that ordinary tool response. Pass its marker token, the exact routed model, and the exact routed reasoning effort to `prepare --client {client} --requested-model {requestedModel} --requested-reasoning-effort {requestedReasoningEffort} --capability-token {token}`. Core first validates the exact routed model/effort, capability provenance, and controller binding, then captures a read-only snapshot, builds an in-memory prepared receipt, atomically consumes the token, and saves the prepared state with the capability session, turn, and tool-use origin. Activation then verifies that spawn belongs to the same session and turn and uses a distinct tool-use. Other clients use the same prepare without a token. Failure creates no baseline, receipt, or child.
6. After prepare, run `task-orchestration <task-ref> dispatch` immediately before calling the fresh native child, then use route's exact model/effort and only the short task ref, skill, `--orchestrated`, and stage identity. The trusted hook-spawn first-observation time must fall between dispatch and the deadline. Its first provenance-sensitive command must be `await-activation --stage ... --round ... --artifact ... --role ...`; before `running`, it must not snapshot, emit stage-started, write business files, or start commit. Only explicit `recover-prepared` may clear an expired orphan when the task fingerprint is exact and no matching unconsumed active lifecycle evidence remains.
7. Codex uses SubagentStart/Stop and App Server actual evidence to activate, consume, and seal one receipt; trusted parent fallback must produce the same complete provenance. Timed-out waits do nothing. Advance only a sealed receipt and repeat step 4 only while running.
8. Create a fresh child each round and never follow up with an old reviewer. Each requested/actual mismatch needs its own host fallback reason. Protocol, capability, receipt hook/profile binding, source, controller, identity, ledger, or fingerprint failure pauses and fails closed; cross-root package/build/contract or hook/profile drift is delivered as a warning instead of blocking natural evolution.
9. On pause or completion, run the matching typed verification and report the structured endpoint.

## Stop

Stop after a safe `commit` or reviewed-head-clean endpoint; do not create a PR, monitor checks, or archive the task.
