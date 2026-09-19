---
name: run-task
description: >
  Orchestrate lifecycle stages from the task's current state with fresh executors/reviewers and recorded execution results.
  Use when one entry should advance an existing task until a safe commit or stable pause.
---

# Run Task Lifecycle

## Task Context Resolution

The entry point may omit the task ref; explicit task scope accepts only `--task <ref>` or `-t <ref>`, and positional task refs are not interpreted. Preserve the four policy options and their values, then call `agent-infra-internal task-context resolve {task-scope}`. Pass through resolution failures without scanning tasks locally. The internal orchestration protocol continues to use a positional task ref.

The orchestrator delegates only and never executes a stage skill itself. First read `.agents/rules/no-mid-flow-questions.md`, `.agents/rules/lifecycle-orchestration.md`, and `reference/host-validation.md`.

1. Resolve the canonical task ID, current Agent Client, and optional atomic policy flags, then run `task-snapshot`. If one explicit role field is present, all four are required.
2. Use the current host's native child spawn, wait, and result interfaces. Task-bound sandboxes forward task operations through the existing broker; retain task binding and checks for real external process operations.
3. Run `task-orchestration {task-id} begin-or-resume --client {client}` with the complete explicit policy. With no explicit policy, core reads that client's configured policy; existing runs use persisted policy. Disk state outside the complete current structure fails closed without rewriting; finish or clear active runs before upgrading. Stop on paused/completed results.
4. Run `route`. On `completed`, run `agent-infra-internal task-verify {task-id} run-task.completed --format text` and stop. Only a `running` result with non-null `next` supplies action, role, round, artifact, requested model, and requested effort.
5. Call `prepare --client {client} --requested-model {requestedModel} --requested-reasoning-effort {requestedReasoningEffort}` with route's exact policy. Codex runs current host preflight. Report actual task, policy, or host failures.
6. After prepare, run `task-orchestration <task-ref> dispatch` before spawning a fresh native child with route's model/effort. Pass the short task ref, skill, `--orchestrated`, and stage identity. The child calls `await-activation --stage ... --round ... --artifact ... --role ...` to associate its actual identity before executing. Code-task creates the local checkpoint; do not delegate a separate commit stage or push. Retain existing write locks without introducing a new lock protocol around native spawn.
7. Record actual start and terminal results through SubagentStart/Stop or parent spawn/wait and App Server observations. A timed-out wait does not imply success. Pause on actual identity, transport, or terminal failures. After the stage and child finish, call `advance`; repeat step 4 only while running.
8. Create a fresh child each round and never reuse a reviewer. Record actual model/effort and host fallback reasons. Validate current identity, artifacts, ledger, and execution results. User rulings override derived historical plan requirements. Do not introduce child discovery, orphan recovery, or a dedicated recovery protocol.
9. On pause or completion, run the matching typed verification and report the structured endpoint.

## Stop

Stop after a safe `commit` or reviewed-head-clean endpoint; do not create a PR, monitor checks, or archive the task.
