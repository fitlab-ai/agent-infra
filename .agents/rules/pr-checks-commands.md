# PR readiness 平台意图

required checks、PR mergeability、轮询 deadline、失败 run/job 定位和日志获取统一由 typed internal intent 执行。每次 inspect/poll 都在同一 PR head 快照上聚合，不跨 head 拼接事实。

GitHub adapter 要求 `gh >= 2.16.0`。平台上下文会在任何 GitHub API、PR 或 checks 操作前检查该依赖；未选择 GitHub 平台时不探测也不依赖 `gh`。

## 快照与监控

```bash
agent-infra-internal platform-checks inspect {task-id}

agent-infra-internal platform-checks watch {task-id} \
  --interval-seconds 30 --deadline-seconds 1800
```

结构化 `readiness.state` 为 `ready|conflicting|checks-failed|pending|timed-out|cancelled`，并携带 `headSha`。仅 `ready` 退出 0；`conflicting|checks-failed` 退出 1；其余或网络阻塞退出 2。`checks.state` 仍保留 check-only 诊断；依赖和确定性平台错误不降级。

## 定位失败 run/job

```bash
agent-infra-internal platform-checks resolve-run {task-id} \
  --check-name {check-name} [--details-url {details-url}]
```

core 优先验证详情链接；否则按 PR head SHA 与 exact check name 查询。零个或多个候选均 fail closed，不选择其他 run。

## 获取失败日志

```bash
agent-infra-internal platform-checks logs {task-id} \
  --run {run-id} [--job {job-id}]
```

日志结果保真返回；缺失、权限、网络和资源不存在使用稳定错误码区分。平台 intent 不修改业务代码、不测试、不提交也不推送。
