---
name: complete-manual-validation
description: >
  标记 PR 人工验证已完成，并原地更新 PR 摘要评论中的人工校验段落。
  当维护者已完成真实环境或权限相关人工验证、需要统一收尾 PR 摘要时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
---

# 完成人工验证
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」。

生命周期事件必须携带显式触发信息：编排调用使用 `{trigger-initiator}=orchestrator`，否则使用 `model`；`{request-id}` 是本任务与本轮产物的稳定单行标识，`{reason-code}` 使用 `user-request` 或 `validation-rerun`；started 与 completed 使用同一组值。


## 行为边界 / 关键规则

## 持久化报告证据

生成验证完成报告时，先读取 `.agents/rules/evidence-reporting.md`。状态核对和同步结果记录命令、范围、结构化结果、实际结论和未覆盖部分；继续遵守人工验证的 basename-only 与 sanitized result 脱敏边界。

- 本技能用于收尾已有 PR 摘要评论中的人工校验状态，不创建并行的普通验证留言。
- 必须写入 `manual-validation.md` 或 `manual-validation-r{N}.md`，让后续 PR 摘要刷新可复用人工验证结果。
- 找不到 `sync-pr` 摘要评论时失败，不创建部分摘要兜底。
- 生成会同步到 Issue 的人工验证 artifact Markdown 前，先读取 `.agents/rules/sync-content-generation.md` 并遵循其中的生成端约束；Issue 同步保持透明，不解析或改写正文。
- 执行本技能后必须立即更新 `task.md`。

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并把原文粘贴到本轮产物的 `## 状态核对` 段：

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

## 任务上下文解析

> 入口可省略 task ref；显式 task scope 仅接受 `--task <ref>` 或 `-t <ref>`，不再解释位置 task ref。保留其余业务操作数后调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

> 解析任务引用，并确认任务位于本技能支持的状态或目录且存在 `task.md`；无法定位时按未找到任务处理并停止。

## 步骤开始：声明 started 事件

确认前置条件和产物上下文后、本轮第一个产出动作之前执行 `agent-infra-internal task-event {task-id} manual-validation.started --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code}`，并以返回的 `artifactContext` 记录本轮身份。

## 执行步骤

### 1. 解析入参

输入格式：

```text
complete-manual-validation [--task <ref> | -t <ref>] [{pr-ref}] {verification-summary}
```

- task scope 可省略；显式 scope 只接受 `--task <ref>` 或 `-t <ref>`。
- `{pr-ref}` 可选，支持 `#NN`、`NN` 或完整 PR URL。
- `{verification-summary}` 必填。若缺失，立即停止并提示补充验证说明；不写产物、不更新 PR。

### 2. 验证前置条件

检查：
- `.agents/workspace/active/{task-id}/task.md`
- 有效 PR：优先使用显式 `{pr-ref}`，否则读取 task.md frontmatter 的 verified `pr_delivery_fact.identity.number`

如果任务不存在、验证说明缺失，或无法解析有效 PR，立即停止。

### 3. 解析产物上下文

运行 `agent-infra-internal task-artifact {task-id} inspect --family manual-validation`。仅当结果为 `ready` 时继续；从 `next.round` / `next.name` 取得本轮 round 与 `{manual-validation-artifact}`。不得自行扫描轮次或拼装文件名。随后执行 started 事件并复核返回身份。

### 4. 更新 PR 摘要

执行此步骤前，先读取：
- `.agents/rules/issue-sync.md`
- `.agents/rules/pr-sync.md`
- `reference/summary-update.md`

按 `reference/summary-update.md` 校验 PR 绑定，从 `platform-pr summary-context` 取得 canonical 输入，并通过 `platform-pr summary-sync` 把人工校验段更新为 `### ✅ 人工验证已通过`。

### 5. 创建人工验证产物

执行此步骤前，先读取 `reference/report-template.md`。创建 `{manual-validation-artifact}`，记录：
- 状态核对
- 验证结论
- 验证范围
- 验证详情
- PR 摘要同步结果

### 6. 更新 task.md

执行 `agent-infra-internal task-event {task-id} manual-validation.completed --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code} --artifact {manual-validation-artifact} --summary-result "{summary-result}"`，由核心在保持 `current_step` 不变的同时原子登记实现备注链接、时间/版本和完成日志。

如任务存在有效 `issue_number`，调用 `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`，再调用 `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {manual-validation-artifact} --agent {standard-agent-token}`。

### 7. 完成校验

运行完成校验：

```bash
agent-infra-internal task-verify {task-id} manual-validation.completed --artifact {manual-validation-artifact} --format text
```

处理结果：
- 退出码 0 -> 告知用户
- 退出码 1 -> 修复问题后重新运行
- 退出码 2 -> 停止并告知需要人工介入

### 8. 告知用户

输出：
- 产物路径
- PR 摘要同步结果
- 当次完成校验输出
- 下一步建议：进入最终收尾流程，运行 /complete-task --task {task-ref}

渲染最终输出前，先读取 `.agents/rules/next-step-output.md`，并在绝对最后一行追加 `Completed at: YYYY-MM-DD HH:mm:ss`。

## 完成检查清单

- [ ] 已读取 `reference/summary-update.md`
- [ ] 已创建人工验证产物
- [ ] 已更新同一条 PR 摘要评论，或按失败语义停止
- [ ] 已更新 task.md 并追加 Activity Log
- [ ] 已运行完成校验
