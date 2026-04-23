---
name: restore-task
description: "从平台 Issue 评论还原本地任务文件"
---

# 还原任务

从带有 sync 标记的平台 Issue 评论中恢复本地任务工作区文件。

## 行为边界 / 关键规则

- 只从带 `<!-- sync-issue:{task-id}:... -->` 标记的评论恢复文件
- 默认恢复到 `.agents/workspace/active/{task-id}/`
- 如果目标目录已存在，立即停止并提示用户先处理目录冲突
- 执行本技能后，你**必须**立即更新恢复出的 `task.md`

## 执行步骤

### 1. 验证输入与环境

检查：
- 必填参数 `{issue-number}`
- 可选参数 `{task-id}`
- 执行前先读取 `.agents/rules/issue-pr-commands.md`，并按其中的认证命令验证当前平台访问能力

如果用户传入了 `{task-id}`，校验其格式为 `TASK-{yyyyMMdd-HHmmss}`。

### 2. 获取 Issue 评论

按 `.agents/rules/issue-pr-commands.md` 中的 “Issue 评论读取” 命令读取 Issue 的全部评论，保留原始顺序和评论 ID。

### 3. 确定 task-id 与待恢复文件

从评论中筛选隐藏标记：

```html
<!-- sync-issue:{task-id}:{file-stem} -->
<!-- sync-issue:{task-id}:{file-stem}:{part}/{total} -->
```

处理规则：
- 用户提供了 `{task-id}` 时，仅匹配该任务
- 未提供时，优先从 `<!-- sync-issue:{task-id}:task -->` 评论推断
- 若找不到唯一 task-id，立即停止并告知用户
- 忽略 `summary` 标记评论；它是 complete-task 的聚合产物，不对应本地任务文件
- 将 `{file-stem}` 映射回文件名：
  - `task` -> `task.md`
  - `analysis` / `analysis-r{N}` -> 对应 `.md`
  - `plan` / `plan-r{N}` -> 对应 `.md`
  - `implementation` / `implementation-r{N}` -> 对应 `.md`
  - `review` / `review-r{N}` -> 对应 `.md`
  - `refinement` / `refinement-r{N}` -> 对应 `.md`

### 4. 处理分片并检查本地目录

执行本步骤前先读取 `.agents/rules/issue-sync.md`。

对每个文件执行：
- 收集单条评论或分片评论
- 对 `task.md` 评论按 issue-sync.md 中的 `<details>` frontmatter 格式反向拆解，提取 frontmatter 后再与正文拼合
- 如存在 `{part}/{total}`，按 part 升序排序并校验分片完整
- 从评论正文中提取文件内容，去掉隐藏标记、标题和页脚
- 拼接得到最终文件内容

在写文件前检查：
- `.agents/workspace/active/{task-id}/` 不存在

如果目录已存在，立即停止并提示用户先手动处理。

### 5. 写回本地文件

创建 `.agents/workspace/active/{task-id}/`，按以下顺序写回：

1. `task.md`
2. 其余产物文件（按文件名排序）

仅写回从 Issue 评论中实际恢复出的文件，不补造缺失文件。

### 6. 更新恢复后的 task.md

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新恢复出的 `task.md`：
- `status`：`active`
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- 保留原 `current_step`
- 在 `## 活动日志` 追加：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Restore Task** by {agent} — Restored task from Issue #{issue-number}
  ```

### 7. 完成校验

运行完成校验：

```bash
node .agents/scripts/validate-artifact.js gate restore-task .agents/workspace/active/{task-id} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 8. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTools`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

输出格式：

```text
任务 {task-id} 已从 Issue #{issue-number} 还原。

摘要：
- 恢复文件：{数量}
- 任务目录：.agents/workspace/active/{task-id}/
- 当前步骤：{current_step}

下一步 - 查看任务状态：
  - Claude Code / OpenCode：/check-task {task-id}
  - Gemini CLI：/{{project}}:check-task {task-id}
  - Codex CLI：$check-task {task-id}
```

## 完成检查清单

- [ ] 已获取并解析 Issue 评论
- [ ] 已还原 `task.md` 和所有可用产物文件
- [ ] 已更新恢复后的 task.md
- [ ] 已运行并通过完成校验
- [ ] 已向用户展示所有 TUI 格式的下一步命令（含自定义 TUI）

## 停止

完成检查清单后立即停止。不要自动继续执行工作流。

## 错误处理

- Issue 不存在或无权访问
- 平台 CLI 未认证
- 找不到带 sync 标记的评论
- 无法唯一确定 `task-id`
- 目标目录已存在
- 分片缺失或顺序不完整
