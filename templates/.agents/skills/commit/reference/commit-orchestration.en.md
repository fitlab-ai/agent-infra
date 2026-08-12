# Commit Orchestration Coordination

This protocol applies only when `{task-id}` was resolved. A taskless Git-only commit must not read, create, or complete a commit intent.

## Execution source

- Bind `{execution-flag}` to `--orchestrated` only when that literal flag appears in the entry business operands.
- Every other invocation is standalone. Never infer the source from `orchestration.json`, environment variables, or activity history.

## Begin before side effects

Call `commit-status` whenever the commit skill starts. For `recoverable` / `prepared`, call `commit-recover --agent {standard-agent-token}`; fail closed for every other non-`idle` state. The recovery intent accepts no token, head, or `--orchestrated` flag.

After read-only preparation of status, copyright, message, review snapshot, and push routing, record `baseline_head=$(git rev-parse HEAD)` and run this before any commit, push, success log, or platform success sync:

```bash
commit_intent_result=$(agent-infra-internal task-orchestration {task-id} commit-begin --agent {standard-agent-token} {execution-flag} --baseline-head "$baseline_head")
commit_intent_token=$(printf '%s' "$commit_intent_result" | node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk).on("end", () => process.stdout.write(JSON.parse(input).token))')
```

Set `commit_intent_token` from the one-use `token` in structured output and keep it only in the current process. A failed begin forbids all later side effects.

## Side-effect checkpoints

Immediately after a normal commit succeeds, record its new HEAD:

```bash
agent-infra-internal task-orchestration {task-id} commit-checkpoint --token "$commit_intent_token" --kind committed --head "$new_head"
```

Immediately after a push succeeds and remote verification completes, record the verified remote/ref/HEAD:

```bash
agent-infra-internal task-orchestration {task-id} commit-checkpoint --token "$commit_intent_token" --kind pushed --head "$pushed_head" --remote "$remote" --ref "$ref"
```

A push-only path skips the committed checkpoint; its pushed HEAD must equal the begin baseline.

## Completion and recovery

After the committed/pushed checkpoint and before task synchronization or `task-verify commit.completed`, run:

```bash
agent-infra-internal task-orchestration {task-id} commit-complete --token "$commit_intent_token" --agent {standard-agent-token}
```

- Before the first side effect, abort only while HEAD still equals the baseline by using `commit-abort --token ... --expected-head ...`.
- After a commit or push, never abort. Retain the intent and use `commit-status` / `commit-recover` for cross-session recovery.
- Stop when `commit-complete` fails. Do not repeat commit/push or mark a run complete without its full receipt lifecycle.
