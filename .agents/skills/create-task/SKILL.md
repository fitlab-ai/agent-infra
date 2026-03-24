---
name: create-task
description: "根据自然语言描述创建任务"
---

# 创建任务

## 行为边界 / 关键规则

**本技能的唯一产出是 `task.md`。**

- 不要编写、修改或创建任何业务代码或配置文件
- 不要执行需求分析；分析由 `analyze-task` 独立完成
- 不要直接实现所描述的功能
- 不要跳过工作流直接进入计划/实现阶段
- 仅执行：解析描述 -> 创建任务文件 -> 更新任务状态 -> 告知用户下一步

用户的描述是一个**待办事项**，而不是**立即执行的指令**。

执行本技能后，你**必须**立即更新 task.md 中的任务状态。

## 执行步骤

### 1. 解析用户描述

从自然语言描述中提取：
- **任务标题**：简洁标题（最多 50 个字符）
- **任务类型**：`feature` | `bugfix` | `refactor` | `docs` | `chore`（从描述推断）
- **工作流**：`feature-development` | `bug-fix` | `refactoring`（从类型推断）
- **详细描述**：整理后的用户原始描述

如果描述不清晰，**先向用户确认**再继续。

**类型推断**：根据任务描述的语义，从以下候选值中选择最匹配的类型：

- `feature` — 新增功能、新特性
- `bugfix` — 修复缺陷、错误
- `refactor` — 重构、优化、改进
- `docs` — 文档相关
- `chore` — 其他杂项任务

**工作流映射**：
- `feature` / `docs` / `chore` -> `feature-development`
- `bugfix` -> `bug-fix`
- `refactor` -> `refactoring`

### 2. 创建任务目录和文件

获取当前时间戳：

```bash
date +%Y%m%d-%H%M%S
```

- 创建任务目录：`.agents/workspace/active/TASK-{yyyyMMdd-HHmmss}/`
- 使用 `.agents/templates/task.md` 模板创建任务文件：`task.md`

**重要**：
- 目录命名：`TASK-{yyyyMMdd-HHmmss}`（**必须**包含 `TASK-` 前缀）
- 示例：`TASK-20260306-143022`
- 任务 ID = 目录名

任务元数据（task.md YAML front matter）：
```yaml
id: TASK-{yyyyMMdd-HHmmss}
type: feature|bugfix|refactor|docs|chore
workflow: feature-development|bug-fix|refactoring
status: active
created_at: {yyyy-MM-dd HH:mm:ss}
updated_at: {yyyy-MM-dd HH:mm:ss}
created_by: human
current_step: requirement-analysis
assigned_to: {当前 AI 代理}
```

注意：`created_by` 为 `human`，因为任务来源于用户的描述。

### 3. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `current_step`：requirement-analysis
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Task Created** by {agent} — Task created from description
  ```

### 4. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

输出格式：
```
任务已创建。

任务信息：
- 任务 ID：{task-id}
- 标题：{title}
- 类型：{type}
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
- [ ] 更新了 task.md 中的 `current_step` 为 requirement-analysis
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 更新了 task.md 中的 `assigned_to`
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，不要筛选）
- [ ] **没有修改任何业务代码或配置文件**（仅 task.md）

## 停止

完成检查清单后，**立即停止**。不要继续执行计划、实现或任何后续步骤。
等待用户执行 `analyze-task` 技能。

## 注意事项

1. **清晰度**：如果用户描述模糊或缺少关键信息，先要求澄清
2. **与 import-issue 的区别**：`import-issue` 从 GitHub Issue 导入任务；`create-task` 从自由描述创建
3. **工作流顺序**：创建任务后，必须先执行 `analyze-task`，再进入 `plan-task`

## 错误处理

- 空描述：提示 "Please provide a task description"
- 描述过于模糊：在创建任务之前提出澄清问题
