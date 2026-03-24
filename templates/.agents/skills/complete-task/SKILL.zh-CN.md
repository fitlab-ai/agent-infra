---
name: complete-task
description: "标记任务完成并归档"
---

# 完成任务

## 行为边界 / 关键规则

- 本命令更新任务元数据并物理移动任务目录
- 除非强制执行，不要归档有未完成工作流步骤的任务

## 执行步骤

### 1. 验证任务存在

检查任务是否存在于 `.agents/workspace/active/{task-id}/`。

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果在 `active/` 中未找到，检查 `blocked/` 和 `completed/`：
- 如果在 `completed/`：告知用户任务已完成
- 如果在 `blocked/`：告知用户任务被阻塞；建议先解除阻塞

### 2. 验证完成前置条件（未满足则必须停止）

标记完成之前，验证以下所有条件：
- [ ] 所有工作流步骤已完成（检查 task.md 中的工作流进度）
- [ ] 代码已审查（`review.md` 或 `review-r{N}.md` 存在，且最新审查结论为 Approved；或已在外部完成审查）
- [ ] 代码已提交（没有与此任务相关的未提交变更）
- [ ] 测试通过

> **⚠️ 前置条件分支判断 — 你必须先判断“继续”还是“停止”：**
>
> - 如果以上所有条件都满足 → 继续步骤 3
> - 如果任意一个条件不满足 → **默认停止**，输出前置条件未满足的警告
> - 只有用户明确要求 `--force` 时，才可以在前置条件未满足时继续
>
> **禁止在前置条件未满足时继续执行步骤 3-7，也不要输出「任务 {task-id} 已完成并归档。」**

如果任何前置条件未满足，警告用户：
```
Cannot complete task {task-id} - prerequisites not met:
- [ ] {缺失的前置条件}

Please complete the missing steps first, or use --force to override.
```

如果前置条件未满足且用户未明确提供 `--force`，立即停止，不执行步骤 3-7。

### 3. 更新任务元数据

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `status`：completed
- `completed_at`：{当前时间戳}
- `updated_at`：{当前时间戳}
- 标记所有工作流步骤为已完成
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Completed** by {agent} — Task archived to completed/
  ```

### 4. 归档任务

将任务目录从 active 移动到 completed：

```bash
mv .agents/workspace/active/{task-id} .agents/workspace/completed/{task-id}
```

### 5. 验证归档

```bash
ls .agents/workspace/completed/{task-id}/task.md
```

确认任务目录已成功移动。

### 6. 同步到 Issue（可选）

检查 `task.md` 中是否存在 `issue_number` 字段，且其值不为空也不为 `N/A`。如果没有，**跳过此步骤，不输出任何内容**。

如果存在有效的 `issue_number`，可选择同步完成状态：

> **重要**：以下列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

```
（可选）同步完成状态到 GitHub Issue：
  - Claude Code / OpenCode：/sync-issue {issue_number}
  - Gemini CLI：/{{project}}:sync-issue {issue_number}
  - Codex CLI：$sync-issue {issue_number}
```

### 7. 告知用户

输出格式：
```
任务 {task-id} 已完成并归档。

任务信息：
- 标题：{title}
- 完成时间：{timestamp}
- 归档路径：.agents/workspace/completed/{task-id}/

交付物：
- {关键产出列表：修改的文件、添加的测试等}
```

## 完成检查清单

- [ ] 验证了所有工作流步骤已完成
- [ ] 更新了 task.md 的完成状态和时间戳
- [ ] 将任务目录移动到 `.agents/workspace/completed/`
- [ ] 验证了归档成功
- [ ] 告知了用户完成情况

## 注意事项

1. **过早完成**：不要归档有未完成步骤的任务。未完成的情况示例：
   - 代码已编写但未提交
   - 代码已提交但未审查
   - 审查发现阻塞项但未修复
   - PR 已创建但未合并

2. **回滚**：如果任务被错误归档：
   ```bash
   mv .agents/workspace/completed/{task-id} .agents/workspace/active/{task-id}
   ```
   然后将 task.md 中的状态改回 `active`。

3. **多贡献者**：如果多个 AI 代理参与了任务，确保所有贡献都已提交后再完成。

## 错误处理

- 任务未找到：提示 "Task {task-id} not found in active directory"
- 已完成：提示 "Task {task-id} is already in completed directory"
- 任务被阻塞：提示 "Task {task-id} is blocked. Unblock it first by moving to active/"
- 移动失败：提示错误并建议手动移动
