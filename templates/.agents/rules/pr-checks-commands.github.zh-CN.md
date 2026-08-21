# GitHub PR readiness 平台意图

PR 全部 checks 的获取、轮询 deadline、失败 run/job 定位和日志获取统一由 typed internal intent 执行。SKILL/模型只负责失败分类、根因分析、最小修复和授权后的提交推送。

GitHub adapter 要求 `gh >= 2.72.0`。平台上下文会在任何 GitHub API、PR 或 checks 操作前检查该依赖；未选择 GitHub 平台时不探测也不依赖 `gh`。

## 快照与监控

```bash
agent-infra-internal platform-checks inspect {task-id}

agent-infra-internal platform-checks watch {task-id} \
  --interval-seconds 30 --deadline-seconds 1800
```

adapter 把 REST `mergeable=false` 规范化为 `conflicting`，null/缺失为 `unknown`，true 为 `mergeable`；true 与诊断 `dirty` 矛盾时降为 `unknown`。`blocked` 等其他诊断不覆盖 REST true。core 在同一 `headSha` 上与全部 checks 聚合：仅 `ready` 退出 0，`conflicting|checks-failed` 退出 1，pending/timeout/cancel/网络阻塞退出 2。依赖与确定性平台错误不降级。

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
