# Required-checks Platform Intents

The GitHub adapter requires `gh >= 2.16.0`. Platform context checks this dependency before any GitHub API, PR, or checks operation. Projects that do not select GitHub neither probe nor depend on `gh`.

```bash
agent-infra-internal platform-checks inspect {task-id}

agent-infra-internal platform-checks watch {task-id} \
  --interval-seconds 30 --deadline-seconds 1800

agent-infra-internal platform-checks resolve-run {task-id} \
  --check-name {check-name} [--details-url {details-url}]

agent-infra-internal platform-checks logs {task-id} \
  --run {run-id} [--job {job-id}]
```

The core owns required-only selection, deadlines, exact run/job resolution, and faithful logs. Green/no-required exits 0; definite failure exits 1; pending, timeout, or network blocking exits 2. Missing dependencies, unsupported versions, and deterministic platform failures preserve their structured errors without compatibility degradation. The skill/model still owns diagnosis, fixes, tests, and authorized commit/push actions.
