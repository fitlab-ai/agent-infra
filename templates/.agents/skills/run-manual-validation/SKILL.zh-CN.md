---
name: run-manual-validation
description: >
  在宿主机安全运行任务人工校验并记录标准证据。
  当校验依赖宿主权限、真实容器或原位工作树状态时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
---

# 运行人工校验

生命周期事件必须携带显式触发信息：编排调用使用 `{trigger-initiator}=orchestrator`，否则使用 `model`；`{request-id}` 是本任务与本轮产物的稳定单行标识，`{reason-code}` 使用 `user-request` 或 `validation-rerun`；started 与 completed 使用同一组值。

## 任务上下文解析

入口可省略 task ref；显式 task scope 仅接受 `--task <ref>` 或 `-t <ref>`，不再解释位置 task ref。先解析 `--scope`、`--timeout`、`--format`，在 `--` 后原样保留用户命令，再调用 `agent-infra-internal task-context resolve {task-scope}`。解析失败时透传非零退出码，不自行扫描任务。内部 `task-validate` 协议仍使用位置 task ref。

跨环境校验（任务工作区在另一台宿主）显式传 `--branch <ref>` 进入 branch-only 降级路径：不调用 `task-context resolve`，直接以该分支 ref 作为 `task-validate` 的位置参数，核心据此返回 `taskId: null` 的 branch-only 证据。未传 `--branch` 时解析失败仍透传非零退出码，不得静默降级。`--task` 与 `--branch` 互斥。

## 行为边界

### 持久化报告证据

生成验证报告时，先读取 `.agents/rules/evidence-reporting.md`。只记录命令名称、目标范围、退出状态、sanitized result 和覆盖缺口；不得记录完整 argv、环境变量、token、绝对路径或原始敏感 transcript。

- 本技能负责选择校验模式、调用唯一机械入口并记录证据；不把 PR 人工校验标为完成。
- `complete-manual-validation` 仍是维护者确认覆盖充分后的最终登记入口。
- 禁止直接操作临时 worktree、lease 或 container；只调用 `agent-infra-internal task-validate`。
- 产物不得记录 token、环境变量、完整 argv、绝对用户路径或原始 transcript；每个验证目标必须由核心写入同一 current-only evidence envelope。
- 生成会同步到 Issue 的验证 artifact Markdown 前，先读取 `.agents/rules/sync-content-generation.md` 并遵循其中的生成端约束；Issue 同步保持透明，不解析或改写正文。
- branch-only 降级路径走 `.agents/workspace/validations/{branch-slug}/`，标记 `recoverable: false`：不写 task.md、不发 lifecycle 事件、不同步 Issue、不跑 `task-verify`；产物须带回宿主机，由维护者登记。

## 第 0 步：状态核对（执行前硬约束）

解析任务引用后运行，并在产物中记录任务/产物范围、关键结果和未覆盖部分；正常成功不粘贴完整目录清单或 `task.md` 尾部，失败、阻塞、身份不一致或争议时附决定性原文行：

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

branch-only 无 `{task-id}`，跳过本步，并在产物 `## 状态核对` 记录 `not-applicable (branch-only)`。

## 执行步骤

1. 读取 `reference/discovery-and-execution.md`，解析输入模式；非法或半截输入在 started 前停止，不写产物。
2. 运行 `agent-infra-internal task-artifact {task-id} inspect --family validation-run`，读取最新 review-code 人工校验项；再运行 `agent-infra-internal platform-pr inspect {task-id}`，按 reference 的状态矩阵发现、归并并编号。仅在自动模式下，可靠来源无项或唯一可能来源不可读时才在 started 前停止；合法显式模式始终以用户命令作为有效工作继续。
3. 从核心结果取得轮次和产物名；确认存在有效显式工作或非空发现清单后，运行 `agent-infra-internal task-event {task-id} validation-run.started --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code}`，并逐项分类为 `executable|unavailable|unknown|unsafe|unresolved`。
4. 为每个验证目标分配 `{evidence-file}`，分别调用 `agent-infra-internal task-validate {task-ref} --scope snapshot --format json --evidence-file {evidence-file} -- {command...}`；只有证据表明必须原位时才对该项进行第二次显式 inplace 调用并写入对应 evidence 文件。零项可执行时不运行伪造命令，但仍继续产出覆盖缺口证据。
5. 读取 `reference/report-template.md`，创建 `validation-run.md|validation-run-r{N}.md`；记录输入模式、发现清单、逐项结果、CLI JSON allowlist 与去敏摘要。
6. 运行 `agent-infra-internal task-event {task-id} validation-run.completed --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code} --artifact {artifact}`。存在 Issue 时依次运行 `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}` 和 `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {artifact} --agent {standard-agent-token}`。
7. 运行 `agent-infra-internal task-verify {task-id} validation-run.completed --artifact {artifact} --format text`；未通过则修复后重跑。
8. 告知用户证据路径、覆盖缺口和验证结果；明确仍需维护者判断是否执行 `complete-manual-validation`。读取 `.agents/rules/next-step-output.md`，最后一行输出 `Completed at`。

## 场景 B：branch-only 降级

传入 `--branch <ref>` 时，相对上述步骤只有以下差异；其余约束（分类、逐项执行、去敏、不改 PR 人工验证完成状态）不变。

- **仅接受显式模式**：`task-artifact` 和 `platform-pr inspect` 都要求 task ref，branch-only 无法自动发现。缺少 `--` 后的用户命令时，在写入任何产物前停止。
- **跳过第 0 步与第 2 步的发现**：把两个来源记为 `unavailable`，并在产物 `## 发现清单` 用 `explicit` 来源登记本轮项。
- **第 3 步只跳过事件调用**：不发 `validation-run.started`，但逐项分类为 `executable|unavailable|unknown|unsafe|unresolved` 照常执行。
- **第 4 步照常执行**：将 evidence 文件写入同一 branch-only validation 目录，调用 `agent-infra-internal task-validate {branch-ref} --scope snapshot --format json --evidence-file {evidence-file} -- {command...}`。
- **第 5 步改写产物位置**：写入 `.agents/workspace/validations/{branch-slug}/validation-run.md|validation-run-r{N}.md`，沿用同一份 `reference/report-template.md`。`{branch-slug}` 由 `--branch` 的 ref 逐字符转换：保留 `[A-Za-z0-9._-]`，其余（含 `/`）一律换成 `-`，结果必须是单层目录名；若结果为空或仅由 `.` 组成，判为非法输入并在写入任何产物前停止。
- **跳过第 6、7 步**：不发 `validation-run.completed`，不做 `platform-comment sync`，不跑 `task-verify`。
- **第 8 步追加提示**：明确告知产物不可恢复、未登记账本，需带回持有任务工作区的宿主机后再由维护者执行 `complete-manual-validation`。

## 完成检查清单

- [ ] 每个可执行项均已使用 `agent-infra-internal task-validate`，或已记录零项可执行
- [ ] 已记录去敏 validation-run 证据
- [ ] 未修改 PR 人工验证完成状态
- [ ] 已更新 task.md 并通过完成校验（branch-only 改为：已记录 `recoverable: false` 且未触碰任务账本）
