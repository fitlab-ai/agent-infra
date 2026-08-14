---
name: run-task
description: >
  Orchestrate lifecycle stages from the task's current state with fresh executors/reviewers and one-use provenance receipts.
  Use when one entry should advance an existing task until a safe commit or stable pause.
---

# Run Task Lifecycle

The orchestrator delegates only and never executes a stage skill itself. First read `.agents/rules/no-mid-flow-questions.md`, `.agents/rules/lifecycle-orchestration.md`, and `reference/host-validation.md`.

1. Resolve the task, current Agent Client, and optional atomic policy flags `--executor-model`, `--executor-reasoning-effort`, `--reviewer-model`, and `--reviewer-reasoning-effort`, then run `task-snapshot`. If any explicit policy flag is present, all four role fields are required and must not be merged with configuration; both roles may use the same model.
2. Run `task-orchestration {task-id} begin-or-resume --client {client}` with the complete explicit policy. With no explicit policy, core reads only that client's `agentClients[].orchestration`; an existing v2 run uses its persisted policy. Only on `ORCHESTRATION_MODEL_POLICY_REQUIRED`, show the complete/partial/interactive-only `agent-client model-selection` context and collect one complete policy; no answer means no run is created. Stop on paused/completed results.
3. Run `route` and read its structured result. On `completed`, immediately run `agent-infra-internal task-verify {task-id} run-task.completed --format text` and stop. Only when the result is `running` with a non-null `next`, use its single action, role, round, artifact, `requestedModel`, and `requestedReasoningEffort`; never infer them from review prose, session defaults, or a partial tool schema.
4. Only for the `running` result from step 3, run `prepare --client {client} --requested-model {requestedModel} --requested-reasoning-effort {requestedReasoningEffort}` so core validates both fields and host evidence before snapshotting. Codex also validates the CLI, features, hook trust/discovery, and App Server schema first; a failed preflight creates neither a receipt nor a workspace baseline. Claude Code's native start event still cannot provide stable actual model/effort evidence and returns `ORCHESTRATION_CLIENT_UNSUPPORTED`. Only after validation succeeds, start a fresh native child with the same model/effort overrides and only the short task ref, skill name, literal `--orchestrated` execution marker, and minimal handoff. The child must forward that marker to every provenance-sensitive command in the stage.
5. Codex prefers SubagentStart/Stop plus App Server actual evidence to activate, consume, and seal the unique receipt. When a custom role does not emit native start/stop, trusted parent PostTool spawn uniquely resolves the child from rollout evidence and a completed wait validates the terminal before idempotent sealing. Timed-out waits do nothing; only empty turns or protocol `inProgress` may wait, while malformed, identity/transport errors, or abnormal terminals pause. Other supported clients keep native start/stop correlation. After the child returns, run `advance` only for a sealed receipt. Repeat step 3 only for `running`; stop immediately for `paused` or `completed`.
6. Create a new child every round and never follow up with an old reviewer. Native start must report actual model and actual reasoning effort; each requested/actual mismatch needs its own host fallback reason, and requested values must never be fabricated as actual evidence. Capability, hook, identity, evidence, ledger, or fingerprint failures must call `pause` and fail closed.
7. On pause or completion, run the matching typed verification and report the structured run summary, pause reason, commit endpoint, or clean completion evidence.

## Stop

Stop after a safe `commit` or reviewed-head-clean endpoint; do not create a PR, monitor checks, or archive the task.
