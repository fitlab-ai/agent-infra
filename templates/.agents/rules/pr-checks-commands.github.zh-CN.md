# PR required checks 平台意图

required checks 的筛选、轮询 deadline、失败 run/job 定位和日志获取统一由 typed internal intent 执行。SKILL/模型只负责失败分类、根因分析、最小修复和授权后的提交推送。

## 快照与监控

```bash
agent-infra-internal platform-checks inspect {task-id}

agent-infra-internal platform-checks watch {task-id} \
  --interval-seconds 30 --deadline-seconds 1800
```

结构化 `checks.state` 为 `passed|failed|pending|timed-out|cancelled|no-required`。`passed|no-required` 退出 0；确定失败/取消退出 1；pending、timeout、网络或无法精确确认 required 集合退出 2。旧平台 CLI 能力不足时必须返回 `degraded/blocked`，不得伪装为全绿。

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
