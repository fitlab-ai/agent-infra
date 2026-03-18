---
name: import-issue
description: >
  从 GitHub Issue 导入并创建任务文件。
  当用户要求导入某个 Issue 时触发。参数：issue 编号。
---

# 导入 Issue

导入指定的 GitHub Issue 并创建任务。参数：issue 编号。

## 行为边界 / 关键规则

- 本技能的唯一产出是 `task.md`
- 不要编写或修改业务代码。仅做导入
- 执行本技能后，你**必须**立即更新任务状态

## 执行流程

### 1. 获取 Issue 信息

```bash
gh issue view <issue-number> --json number,title,body,labels
```

提取：issue 编号、标题、描述、标签。

### 2. 检查已有任务

搜索 `.agent-workspace/active/` 中是否已有链接到此 Issue 的任务。
- 如果找到，询问用户是重新导入还是继续使用现有任务
- 如果未找到，创建新任务

### 3. 创建任务目录和文件

```bash
date +%Y%m%d-%H%M%S
```

- 创建目录：`.agent-workspace/active/TASK-{yyyyMMdd-HHmmss}/`
- 使用 `.agents/templates/task.md` 模板创建 `task.md`

任务元数据：
```yaml
id: TASK-{yyyyMMdd-HHmmss}
issue_number: <issue-number>
type: feature|bugfix|refactor|docs|chore
workflow: feature-development|bug-fix|refactoring
status: active
created_at: {yyyy-MM-dd HH:mm:ss}
updated_at: {yyyy-MM-dd HH:mm:ss}
created_by: human
current_step: requirement-analysis
assigned_to: {当前 AI 代理}
```

### 4. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 `.agent-workspace/active/{task-id}/task.md`：
- `current_step`：requirement-analysis
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Import Issue** by {agent} — Issue #{number} imported
  ```

### 5. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

```
Issue #{number} 已导入。

任务信息：
- 任务 ID：{task-id}
- 标题：{title}
- 工作流：{workflow}

产出文件：
- 任务文件：.agent-workspace/active/{task-id}/task.md

下一步 - 执行需求分析：
  - Claude Code / OpenCode：/analyze-task {task-id}
  - Gemini CLI：/agent-infra:analyze-task {task-id}
  - Codex CLI：$analyze-task {task-id}
```

## 完成检查清单

- [ ] 创建了任务文件 `.agent-workspace/active/{task-id}/task.md`
- [ ] 在 task.md 中记录了 issue_number
- [ ] 更新了 `current_step` 为 requirement-analysis
- [ ] 更新了 `updated_at` 为当前时间
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，不要筛选）
- [ ] **没有修改任何业务代码**

## 停止

完成检查清单后，**立即停止**。不要继续执行后续步骤。

## 注意事项

1. **Issue 验证**：在继续之前检查 Issue 是否存在
2. **重复任务**：如果此 Issue 已有关联任务，在创建新任务前询问用户
3. **下一步**：导入完成后，先执行 `analyze-task`，再进入 `plan-task`

## 错误处理

- Issue 未找到：提示 "Issue #{number} not found, please check the issue number"
- 网络错误：提示 "Cannot connect to GitHub, please check network"
- 权限错误：提示 "No access to this repository"
