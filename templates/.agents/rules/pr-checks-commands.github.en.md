# GitHub PR Readiness Intents

The GitHub adapter requires `gh >= 2.72.0`. Platform context checks this dependency before any GitHub API, PR, or checks operation. Projects that do not select GitHub neither probe nor depend on `gh`.

```bash
agent-infra-internal platform-checks inspect {task-id}

agent-infra-internal platform-checks watch {task-id} \
  --interval-seconds 30 --deadline-seconds 1800

agent-infra-internal platform-checks resolve-run {task-id} \
  --check-name {check-name} [--details-url {details-url}]

agent-infra-internal platform-checks logs {task-id} \
  --run {run-id} [--job {job-id}]
```

The adapter normalizes REST `mergeable=false` to `conflicting`, null/missing to `unknown`, and true to `mergeable`; `mergeable=true` plus diagnostic `dirty` is contradictory and becomes `unknown`. Other diagnostics such as `blocked` do not override REST true. Core combines that fact with all checks for one `headSha`: only `ready` exits 0, `conflicting|checks-failed` exit 1, and pending/timeout/cancel/network blocking exit 2. Dependency and deterministic platform errors are preserved without degradation.
