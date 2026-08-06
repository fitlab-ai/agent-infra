---
name: run-task
description: >
  Orchestrate lifecycle stages from the task's current state with fresh executors/reviewers and one-use provenance receipts.
  Use when one entry should advance an existing task until a safe commit or stable pause.
---

# Run Task Lifecycle

The orchestrator delegates only and never executes a stage skill itself. First read `.agents/rules/no-mid-flow-questions.md`, `.agents/rules/lifecycle-orchestration.md`, and `reference/host-validation.md`.

1. Resolve the task, current Agent Client, and optional atomic policy flags `--executor-model`, `--executor-reasoning-effort`, `--reviewer-model`, `--reviewer-reasoning-effort`, and `--same-model-reason`, then run `task-snapshot`. If any explicit policy flag is present, all four role fields are required and must not be merged with configuration.
2. Run `task-orchestration {task-id} begin-or-resume --client {client}` with the complete explicit policy. With no explicit policy, core reads only that client's `agentClients[].orchestration`; an existing v2 run uses its persisted policy. Only on `ORCHESTRATION_MODEL_POLICY_REQUIRED`, show the complete/partial/interactive-only `agent-client model-selection` context and collect one complete policy; no answer means no run is created. Stop on paused/completed results.
3. Run `route` and use its single action, role, round, artifact, `requestedModel`, and `requestedReasoningEffort`. Never infer them from review prose, session defaults, or a partial tool schema.
4. Run `prepare --client {client} --requested-model {requestedModel} --requested-reasoning-effort {requestedReasoningEffort}` so core validates both fields and host evidence before snapshotting. Start a fresh native child with the same model/effort overrides and only the short task ref, skill name, and minimal handoff.
5. Native start/stop hooks correlate the unique pending delegation and let core compute workspace changes and seal the receipt. After the child returns, run `advance`. Repeat step 3 only for `running`; stop immediately for `paused` or `completed`.
6. Create a new child every round and never follow up with an old reviewer. Native start must report actual model and actual reasoning effort; each requested/actual mismatch needs its own host fallback reason, and requested values must never be fabricated as actual evidence. Capability, hook, identity, evidence, ledger, or fingerprint failures must call `pause` and fail closed.
7. On pause or completion, run the matching typed verification and report the structured run summary, pause reason, or commit endpoint.

## Stop

The first release ends after a safe `commit`; do not create a PR, monitor checks, or complete the task.
