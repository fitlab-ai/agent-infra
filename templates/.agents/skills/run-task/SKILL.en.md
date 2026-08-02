---
name: run-task
description: >
  Orchestrate lifecycle stages from the task's current state with fresh executors/reviewers and one-use provenance receipts.
  Use when one entry should advance an existing task until a safe commit or stable pause.
---

# Run Task Lifecycle

The orchestrator delegates only and never executes a stage skill itself. First read `.agents/rules/no-mid-flow-questions.md` and `.agents/rules/lifecycle-orchestration.md`.

1. Resolve the task and run `agent-infra-internal task-snapshot {task-id} --format text`.
2. Run `agent-infra-internal task-orchestration {task-id} begin-or-resume`; stop on structured paused/completed results.
3. Run `route` and use its single action, role, round, and artifact. Never infer routing from review prose.
4. Run `prepare`, then start the specified executor/reviewer with the current client's fresh native subagent mechanism. Pass only the short task reference, skill name, and minimal handoff; never pass receipt identity or inherit orchestrator history.
5. After the child returns and the native stop hook seals its receipt, run `advance`. Repeat step 3 only for `running`; stop immediately for `paused` or `completed`.
6. Create a new child every round and never follow up with an old reviewer. Capability, hook, identity, model fallback, ledger, or fingerprint failures must call `pause` and fail closed.
7. On pause or completion, run the matching typed verification and report the structured run summary, pause reason, or commit endpoint.

## Stop

The first release ends after a safe `commit`; do not create a PR, monitor checks, or complete the task.

