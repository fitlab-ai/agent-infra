---
name: run-manual-validation
description: >
  在宿主机安全运行任务人工校验并记录标准证据。
  当校验依赖宿主权限、真实容器或原位工作树状态时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
---

# 运行人工校验

## 行为边界

- 本技能负责选择校验模式、调用唯一机械入口并记录证据；不把 PR 人工校验标为完成。
- `complete-manual-validation` 仍是维护者确认覆盖充分后的最终登记入口。
- 禁止直接操作临时 worktree、lease 或 container；只调用 `ai task validate`。
- 产物不得记录 token、环境变量、完整 argv、绝对用户路径或原始 transcript。

## 第 0 步：状态核对（执行前硬约束）

解析任务引用后运行，并把原文写入产物：

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

## 执行步骤

1. 解析 `{task-ref}`、验证目标和 `--` 后的命令；缺失时停止，不写产物。
2. 运行 `agent-infra-internal task-artifact {task-id} inspect --family validation-run`，从核心结果取得轮次和产物名；随后运行 `agent-infra-internal task-event {task-id} validation-run.started --agent {standard-agent-token}`。
3. 选择模式：固定提交只查用 snapshot；依赖未提交内容、原挂载或原位权限用 inplace；不确定时先 snapshot，只有证据表明必须原位时才升级。
4. 调用 `ai task validate {task-ref} --scope {scope} --format json -- {command...}`。运行时升级必须作为第二次显式 inplace 调用，并记录理由。
5. 读取 `reference/report-template.md`，创建 `validation-run.md|validation-run-r{N}.md`；只写 CLI JSON allowlist 与去敏摘要。
6. 运行 `agent-infra-internal task-event {task-id} validation-run.completed --agent {standard-agent-token} --artifact {artifact}`。存在 Issue 时依次运行 `agent-infra-internal platform-comment sync {task-id}` 和 `agent-infra-internal platform-comment sync-artifact {task-id} --artifact {artifact}`。
7. 运行 `agent-infra-internal task-verify {task-id} validation-run.completed --artifact {artifact} --format text`；未通过则修复后重跑。
8. 告知用户证据路径、覆盖缺口和验证结果；明确仍需维护者判断是否执行 `complete-manual-validation`。读取 `.agents/rules/next-step-output.md`，最后一行输出 `Completed at`。

## 完成检查清单

- [ ] 已使用 `ai task validate`
- [ ] 已记录去敏 validation-run 证据
- [ ] 未修改 PR 人工验证完成状态
- [ ] 已更新 task.md 并通过完成校验
