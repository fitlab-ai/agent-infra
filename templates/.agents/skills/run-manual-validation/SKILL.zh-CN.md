---
name: run-manual-validation
description: >
  在宿主机安全运行任务人工校验并记录标准证据。
  当校验依赖宿主权限、真实容器或原位工作树状态时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
---

# 运行人工校验

## 任务上下文解析

入口可省略 task ref；显式 task scope 仅接受 `--task <ref>` 或 `-t <ref>`，不再解释位置 task ref。先解析 `--scope`、`--timeout`、`--format`，在 `--` 后原样保留用户命令，再调用 `agent-infra-internal task-context resolve {task-scope}`。解析失败时透传非零退出码，不自行扫描任务。内部 `task-validate` 协议仍使用位置 task ref。

## 行为边界

- 本技能负责选择校验模式、调用唯一机械入口并记录证据；不把 PR 人工校验标为完成。
- `complete-manual-validation` 仍是维护者确认覆盖充分后的最终登记入口。
- 禁止直接操作临时 worktree、lease 或 container；只调用 `agent-infra-internal task-validate`。
- 产物不得记录 token、环境变量、完整 argv、绝对用户路径或原始 transcript。

## 第 0 步：状态核对（执行前硬约束）

解析任务引用后运行，并把原文写入产物：

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

## 执行步骤

1. 读取 `reference/discovery-and-execution.md`，解析输入模式；非法或半截输入在 started 前停止，不写产物。
2. 运行 `agent-infra-internal task-artifact {task-id} inspect --family validation-run`，读取最新 review-code 人工校验项；再运行 `agent-infra-internal platform-pr inspect {task-id}`，按 reference 的状态矩阵发现、归并并编号。仅在自动模式下，可靠来源无项或唯一可能来源不可读时才在 started 前停止；合法显式模式始终以用户命令作为有效工作继续。
3. 从核心结果取得轮次和产物名；确认存在有效显式工作或非空发现清单后，运行 `agent-infra-internal task-event {task-id} validation-run.started --agent {standard-agent-token}`，并逐项分类为 `executable|unavailable|unknown|unsafe|unresolved`。
4. 每个可执行项分别调用 `agent-infra-internal task-validate {task-ref} --scope snapshot --format json -- {command...}`；只有证据表明必须原位时才对该项进行第二次显式 inplace 调用。零项可执行时不运行伪造命令，但仍继续产出覆盖缺口证据。
5. 读取 `reference/report-template.md`，创建 `validation-run.md|validation-run-r{N}.md`；记录输入模式、发现清单、逐项结果、CLI JSON allowlist 与去敏摘要。
6. 运行 `agent-infra-internal task-event {task-id} validation-run.completed --agent {standard-agent-token} --artifact {artifact}`。存在 Issue 时依次运行 `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}` 和 `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {artifact} --agent {standard-agent-token}`。
7. 运行 `agent-infra-internal task-verify {task-id} validation-run.completed --artifact {artifact} --format text`；未通过则修复后重跑。
8. 告知用户证据路径、覆盖缺口和验证结果；明确仍需维护者判断是否执行 `complete-manual-validation`。读取 `.agents/rules/next-step-output.md`，最后一行输出 `Completed at`。

## 完成检查清单

- [ ] 每个可执行项均已使用 `agent-infra-internal task-validate`，或已记录零项可执行
- [ ] 已记录去敏 validation-run 证据
- [ ] 未修改 PR 人工验证完成状态
- [ ] 已更新 task.md 并通过完成校验
