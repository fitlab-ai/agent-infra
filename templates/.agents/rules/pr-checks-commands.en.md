# PR Readiness Platform Intents

Typed intents own required-check selection, PR mergeability, polling deadlines, run/job resolution, and logs. Every inspect/poll aggregates facts from one PR head snapshot; facts are never mixed across heads.

```bash
agent-infra-internal platform-checks inspect {task-id}

agent-infra-internal platform-checks watch {task-id} \
  --interval-seconds 30 --deadline-seconds 1800

agent-infra-internal platform-checks resolve-run {task-id} \
  --check-name {check-name} [--details-url {details-url}]

agent-infra-internal platform-checks logs {task-id} \
  --run {run-id} [--job {job-id}]
```

`readiness.state` is `ready|conflicting|checks-failed|pending|timed-out|cancelled` and carries `headSha`. Only `ready` exits 0; conflicting/check failures exit 1; all other readiness or network blocking exits 2. `checks.state` remains available as check-only diagnostics. Adapter dependency and deterministic platform errors are preserved without degradation. Platform intents never edit business code or push.
