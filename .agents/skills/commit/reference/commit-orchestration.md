# Commit 编排协调

本规则仅适用于已解析出 `{task-id}` 的提交。无任务上下文的纯 Git 提交不得读取、创建或完成 commit intent。

## 执行来源

- 只有入口业务操作数中字面出现 `--orchestrated` 时，`{execution-flag}` 才绑定为 `--orchestrated`。
- 其他调用一律为 standalone；不得从 `orchestration.json`、环境变量或历史活动日志推断来源。

## 副作用前 begin

每次进入 commit 技能先调用 `commit-status`。`recoverable` / `prepared` / `retryable-start` 调用以下无 token 恢复入口，`idle` 调用 `commit-start --agent {standard-agent-token}`；其他状态 fail closed：

```bash
agent-infra-internal task-orchestration {task-id} commit-recover --agent {standard-agent-token}
```

恢复入口只接受 `--agent`；不得传 token、head 或 `--orchestrated`。从 start/recover 结构化输出读取 `finalization.attempt.attempt` 为 `commit_attempt`，不得手写 attempt。

完成状态、版权、提交信息、review snapshot 和 push 场景的只读准备后，记录 `baseline_head=$(git rev-parse HEAD)`，并在任何 commit、push、任务成功日志或平台成功同步之前调用：

```bash
commit_intent_result=$(agent-infra-internal task-orchestration {task-id} commit-begin --agent {standard-agent-token} {execution-flag} --baseline-head "$baseline_head" --attempt "$commit_attempt")
commit_intent_token=$(printf '%s' "$commit_intent_result" | node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk).on("end", () => process.stdout.write(JSON.parse(input).token))')
```

`commit_intent_token` 只从结构化输出读取一次性 `token`，并仅保存在当前进程内。begin 失败时不得执行后续副作用。

## 副作用 checkpoint

普通 commit 成功后立即记录新 HEAD：

```bash
agent-infra-internal task-orchestration {task-id} commit-checkpoint --token "$commit_intent_token" --kind committed --head "$new_head"
```

push 成功并完成远端复核后立即记录已验证的 remote/ref/HEAD：

```bash
agent-infra-internal task-orchestration {task-id} commit-checkpoint --token "$commit_intent_token" --kind pushed --head "$pushed_head" --remote "$remote" --ref "$ref"
```

普通分支 push 失败时保留 `committed` intent；push-only 重试只校验当前 HEAD/baseline/remote/ref 后推送，不重复创建 commit。commit caller 必须把 `{ branch, automatic }` policy 传给 `git-workflow push`：普通分支尝试一次 HEAD push，`main` / `master` 跳过自动 push 并返回 `committed_with_warnings`，但本地 committed checkpoint 仍必须完成。create-pr 只复核远端交付，不负责首次 push；通用 `git-workflow push` 和 release caller 不携带该 policy。

policy push input 示例：

```json
{
  "remote": "origin",
  "refs": ["refs/heads/{branch}"],
  "policy": { "branch": "{branch}", "automatic": true }
}
```

## 完成与恢复

committed/pushed checkpoint 完成后、任务同步与 `task-verify commit.completed` 之前调用：

```bash
agent-infra-internal task-orchestration {task-id} commit-complete --token "$commit_intent_token" --agent {standard-agent-token}
```

- begin 已创建 intent、但第一个副作用前失败时，先在 HEAD 仍等于 baseline 时调用 `commit-abort --token ... --expected-head ...`；若本轮明确放弃，再调用 `commit-terminate --attempt "$commit_attempt" --agent {standard-agent-token} --code <STABLE_CODE>` 闭合 started。
- begin 在 intent 创建前失败时可保留 attempt 供下次复用；明确放弃时仅可在 HEAD 未漂移时调用 `commit-terminate`。
- commit 或 push 发生后失败时不得 abort；保留 intent，并调用 `commit-status` 输出不含 token/digest 的恢复证据。跨会话重跑通过 `commit-recover` 收尾。
- `commit-complete` 失败时停止。不得重复执行 commit/push，也不得把缺少完整 receipt 生命周期的 run 标记为完成。
