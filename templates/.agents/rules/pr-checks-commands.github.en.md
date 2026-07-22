# Required-checks Platform Intents

```bash
agent-infra-internal platform-checks inspect {task-id}

agent-infra-internal platform-checks watch {task-id} \
  --interval-seconds 30 --deadline-seconds 1800

agent-infra-internal platform-checks resolve-run {task-id} \
  --check-name {check-name} [--details-url {details-url}]

agent-infra-internal platform-checks logs {task-id} \
  --run {run-id} [--job {job-id}]
```

The core owns required-only selection, deadlines, exact run/job resolution, and faithful logs. Green/no-required exits 0; definite failure exits 1; pending, timeout, network, or degraded required-set detection exits 2. The skill/model still owns diagnosis, fixes, tests, and authorized commit/push actions.
