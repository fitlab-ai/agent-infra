# Required-checks Platform Intents

Typed intents own required-only selection, polling deadlines, run/job resolution, and log retrieval. The skill/model owns failure classification, root-cause analysis, minimum fixes, tests, and authorized commit/push actions.

```bash
agent-infra-internal platform-checks inspect {task-id}

agent-infra-internal platform-checks watch {task-id} \
  --interval-seconds 30 --deadline-seconds 1800

agent-infra-internal platform-checks resolve-run {task-id} \
  --check-name {check-name} [--details-url {details-url}]

agent-infra-internal platform-checks logs {task-id} \
  --run {run-id} [--job {job-id}]
```

`checks.state` is `passed|failed|pending|timed-out|cancelled|no-required`. Green/no-required exits 0; definite failure/cancellation exits 1; pending, timeout, or network blocking exits 2. Each platform adapter validates its own dependencies before operations and preserves dependency or deterministic platform errors without compatibility degradation. Run resolution prefers a validated details URL and otherwise requires one exact PR-head/check-name match. Platform intents never edit business code or push.
