---
name: import-issue
description: "从 GitHub Issue 导入并创建任务"
---

# 导入 Issue

导入指定的 GitHub Issue 并创建任务。参数：issue 编号。

## 行为边界 / 关键规则

- 本技能的唯一产出是 `task.md`
- 不要编写或修改业务代码。仅做导入
- 执行本技能后，你**必须**立即更新任务状态

## 执行流程

### 1. 获取 Issue 信息

执行前先读取 `.agents/rules/issue-pr-commands.md`，并按其中的前置步骤完成认证和代码托管平台检测；随后按其中的 “读取 Issue” 命令获取 Issue 信息。

提取：issue 编号、标题、描述、标签。
任务标题直接使用 Issue 的原始标题（保持 Issue 标题的原始语言）。

### 2. 检查已有任务

搜索 `.agents/workspace/active/` 中是否已有链接到此 Issue 的任务。
- 如果找到，询问用户是重新导入还是继续使用现有任务
- 如果未找到，创建新任务

### 3. 创建任务目录和文件

```bash
date +%Y%m%d-%H%M%S
```

- 创建目录：`.agents/workspace/active/TASK-{yyyyMMdd-HHmmss}/`
- 使用 `.agents/templates/task.md` 模板创建 `task.md`

任务元数据：
```yaml
id: TASK-{yyyyMMdd-HHmmss}
issue_number: <issue-number>
type: feature|bugfix|refactor|docs|chore
branch: <project>-<type>-<slug>
workflow: feature-development|bug-fix|refactoring
status: active
created_at: {YYYY-MM-DD HH:mm:ss±HH:MM}
updated_at: {YYYY-MM-DD HH:mm:ss±HH:MM}
created_by: human
current_step: requirement-analysis
assigned_to: {当前 AI 代理}
```

### 4. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `current_step`：requirement-analysis
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- `## 上下文` 中的 `- **分支**：`：更新为生成的分支名
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Import Issue** by {agent} — Issue #{number} imported
  ```

### 5. 分配 Issue Assignee

如果 task.md 中存在有效的 `issue_number`，按 `.agents/rules/issue-pr-commands.md` 的 Issue 更新命令为当前执行者添加 assignee；Assignee 同步的边界仍遵循 `.agents/rules/issue-sync.md`。

### 6. 同步到 Issue

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续）：
- 执行前先读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测
- 检查 Issue 当前 milestone；如果未设置，先读取 `.agents/rules/milestone-inference.md`，按其中的「阶段 1：`create-issue`」规则推断并设置 milestone；如果 `has_triage=false` 或推断不确定，跳过并继续
- 创建或更新 `<!-- sync-issue:{task-id}:task -->` 评论（按 issue-sync.md 的 task.md 评论同步规则）

### 7. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate import-issue .agents/workspace/active/{task-id} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 8. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

```
Issue #{number} 已导入。

任务信息：
- 任务 ID：{task-id}
- 标题：{title}
- 工作流：{workflow}

产出文件：
- 任务文件：.agents/workspace/active/{task-id}/task.md

下一步 - 执行需求分析：
  - Claude Code / OpenCode：/analyze-task {task-id}
  - Gemini CLI：/agent-infra:analyze-task {task-id}
  - Codex CLI：$analyze-task {task-id}
```

## 完成检查清单

- [ ] 创建了任务文件 `.agents/workspace/active/{task-id}/task.md`
- [ ] 在 task.md 中记录了 issue_number
- [ ] 更新了 `current_step` 为 requirement-analysis
- [ ] 更新了 `updated_at` 为当前时间
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 同步了 task 评论到 Issue
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，含自定义 TUI，不要筛选）
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
