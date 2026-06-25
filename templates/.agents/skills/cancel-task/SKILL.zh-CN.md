---
name: cancel-task
description: >
  取消不再需要的任务并转移。
  当某个任务不再需要、应从 active 工作中撤下时使用。
---

# 取消任务

## 行为边界 / 关键规则

- 本命令用于终止一个不再需要继续执行的任务，并转移到 `completed/`
- 只有在确认该任务无需继续实现、审查或修复时才可取消
- 有效 `issue_number` 存在时，Issue 同步属于必做项

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：写入 started 标记

确认前置条件后、本步骤第一个产出动作之前，向 task.md `## 活动日志` 追加一条 started 标记（与本步骤 done 条目同基名 + ` [started]` 后缀，note 用 `started`）：

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Cancel Task [started]** by {agent} — started
```

`ai task log` 会把它与完成时写入的 done 条目配对成一行（进行中 → 已完成）。约定见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

## 执行步骤
### 1. 验证任务存在

依次检查以下目录：
- `.agents/workspace/active/{task-id}/`
- `.agents/workspace/blocked/{task-id}/`
- `.agents/workspace/completed/{task-id}/`

处理规则：
- 如果在 `active/` 或 `blocked/` 中找到：继续
- 如果只在 `completed/` 中找到：告知用户任务已转移，停止
- 如果都不存在：提示 `Task {task-id} not found`

### 2. 判断取消标签

根据取消原因推断 Issue 关闭标签：
- `status: superseded`：原因包含“重复”、“替代”、“合并到”、“已由 #123 / PR 替代”等语义
- `status: invalid`：原因包含“误报”、“不存在”、“无法复现”、“排查后无问题”等语义
- `status: declined`：原因包含“不做”、“暂不实现”、“优先级调整”、“方案否决”等语义
- 以上都不匹配：回退到 `status: declined`

后续同步到 Issue 时，使用最终推断结果替换现有 `status:` labels。

### 3. 更新任务元数据

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新任务目录中的 `task.md`：
- `status`：completed
- `cancelled_at`：{当前时间戳}
- `cancel_reason`：{取消原因}
- `updated_at`：{当前时间戳}
- `agent_infra_version`：按 `.agents/rules/version-stamp.md` 取值
- **追加**到 `## Activity Log`（不要覆盖之前记录）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Cancel Task** by {agent} — {一行取消原因}
  ```

### 4. 转移任务

将任务目录移动到 `.agents/workspace/completed/{task-id}`。

如果源目录在 `blocked/`，从 `blocked/` 移动；如果源目录在 `active/`，从 `active/` 移动。

### 5. 验证转移

```bash
ls .agents/workspace/completed/{task-id}/task.md
```

确认任务目录已成功移动。

### 6. 同步到 Issue

检查 `task.md` 中是否存在有效的 `issue_number`。如果没有，跳过此步骤。

> Issue 同步规则见 `.agents/rules/issue-sync.md`。执行同步前先读取该文件，完成 upstream 仓库检测和权限检测。
> 关闭 Issue 前先读取 `.agents/rules/issue-pr-commands.md`。

如果存在有效的 `issue_number`：
- 按 issue-sync.md 替换所有 `status:` labels，并设置步骤 2 推断出的标签
- 按 issue-sync.md 移除所有 `in:` labels
- 按 issue-sync.md 移除 milestone
- 移除全部 assignees（无权限时直接跳过，不做替代）
- 发布取消评论，隐藏标记使用 `.agents/rules/issue-sync.md` 中定义的 cancel 评论标记
- 使用 `.agents/rules/issue-sync.md` 的 task.md 评论同步规则创建或更新 `.agents/rules/issue-sync.md` 中定义的 task 评论标记
- 关闭 Issue：按 `.agents/rules/issue-pr-commands.md` 中的“关闭 Issue”命令执行，关闭原因固定为 `not planned`

取消评论至少包含：
- 取消原因
- 选定的 `status:` label

### 7. 完成校验

**释放短号**（先 `mv` 目录已成功，再 release；脚本幂等，未在注册表也返回 0）：

```bash
node .agents/scripts/task-short-id.js release "$task_id" || true
```

运行完成校验，确认任务转移和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate cancel-task .agents/workspace/completed/{task-id} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 8. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。 渲染最终输出前，先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令把 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

> **可选沙箱清理提示（门控渲染）**：仅当同时满足 (1) `.agents/.airc.json` 存在 `sandbox` 字段、(2) task.md 的 `branch` 字段存在且不是 `main` / `master` 时，才渲染下方输出中「目标路径」之后、「下一步」之前的「可选：清理本任务的沙箱」块；任一不满足则整段省略。`{branch}` 取已读入的 task.md 的 `branch` 值（任务此时已移动到 completed/，从 `.agents/workspace/completed/{task-id}/task.md` 读取）。该块独立于「下一步」语义。

输出格式：
```
任务 {task-id} 已取消，任务目录已转移到 completed/。

取消原因：{reason}
状态标签：{status-label 或 skipped}
目标路径：.agents/workspace/completed/{task-id}/

可选：清理本任务的沙箱
（任务已归档，沙箱容器和 per-branch 配置目录不会自动回收。如果不再需要可执行：）

ai sandbox rm {branch}

下一步 - 查看已转移任务：
  - Claude Code / OpenCode：/check-task {task-ref}
  - Gemini CLI：/agent-infra:check-task {task-ref}
  - Codex CLI：$check-task {task-ref}
```



## 完成检查清单

- [ ] 已记录取消原因并更新 task.md
- [ ] 已将任务目录移动到 `.agents/workspace/completed/`
- [ ] 已在存在 Issue 时完成 Issue 同步
- [ ] 已运行 gate 校验并通过
- [ ] 已向用户展示完整的下一步命令（含自定义 TUI）

## 注意事项

1. 取消任务不会新增 `cancelled` 状态值，而是复用 `completed`
2. 必须通过 `cancelled_at` 和 `cancel_reason` 区分“取消”与“正常完成”
3. 如果 Issue 关闭失败，不要宣称取消完成

## 错误处理

- 任务未找到：`Task {task-id} not found`
- 任务已转移：提示任务已在 `completed/` 中
- Issue 同步失败：保留本地转移结果，并告知用户需要人工补齐平台操作
