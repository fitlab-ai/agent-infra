---
name: create-task
description: >
  根据用户的自然语言描述创建任务并执行需求分析。当用户描述一个新功能、Bug 或改进需求时触发。
  唯一的产出是 task.md 和 analysis.md —— 不编写任何业务代码。参数：任务描述文本。
---

# 创建任务

## 行为边界 / 关键规则

**本技能的唯一产出是 `task.md` 和 `analysis.md`。**

- 不要编写、修改或创建任何业务代码或配置文件
- 不要直接实现所描述的功能
- 不要跳过工作流直接进入计划/实现阶段
- 仅执行：解析描述 -> 创建任务文件 -> 需求分析 -> 输出分析文档 -> 告知用户下一步

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

**类型推断规则**：
- 包含 "add"、"new"、"support"、"implement" -> `feature`
- 包含 "fix"、"resolve"、"bug"、"error" -> `bugfix`
- 包含 "refactor"、"optimize"、"improve"、"clean up" -> `refactor`
- 包含 "document"、"javadoc"、"comment"、"readme" -> `docs`
- 其他 -> `chore`

**工作流映射**：
- `feature` / `docs` / `chore` -> `feature-development`
- `bugfix` -> `bug-fix`
- `refactor` -> `refactoring`

### 2. 创建任务目录和文件

获取当前时间戳：

```bash
date +%Y%m%d-%H%M%S
```

- 创建任务目录：`.ai-workspace/active/TASK-{yyyyMMdd-HHmmss}/`
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

### 3. 执行需求分析

遵循 `.agents/workflows/feature-development.yaml` 中的 `requirement-analysis` 步骤：

**必要任务**（仅分析，不编写任何业务代码）：
- [ ] 理解用户描述的需求
- [ ] 搜索相关代码文件（**只读**）
- [ ] 分析代码结构和影响范围
- [ ] 识别潜在技术风险和依赖
- [ ] 评估工作量和复杂度

### 4. 输出分析文档

创建 `.ai-workspace/active/{task-id}/analysis.md`，包含以下部分：

## 输出模板

```markdown
# 需求分析报告

## 需求来源

**来源类型**：用户自然语言描述
**原始描述**：
> {用户的原始描述}

## 需求理解
{用自己的话重述需求以确认理解}

## 相关文件
- `{file-path}:{line-number}` - {描述}

## 影响评估
**直接影响**：
- {受影响的模块和文件}

**间接影响**：
- {可能受影响的其他部分}

## 技术风险
- {风险描述和缓解思路}

## 依赖关系
- {需要的依赖和与其他模块的协调}

## 工作量和复杂度评估
- 复杂度：{高/中/低}
- 风险等级：{高/中/低}
```

### 5. 更新任务状态

更新 `.ai-workspace/active/{task-id}/task.md`：
- `current_step`：requirement-analysis
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- 标记 analysis.md 为已完成
- 在工作流进度中标记 requirement-analysis 为已完成

### 6. 告知用户

输出格式：
```
Task created and analysis complete.

Task info:
- Task ID: {task-id}
- Title: {title}
- Type: {type}
- Workflow: {workflow}

Output files:
- Task file: .ai-workspace/active/{task-id}/task.md
- Analysis: .ai-workspace/active/{task-id}/analysis.md

Next step - review the analysis, then design the technical plan:
  execute the plan-task skill with {task-id}
```

## 完成检查清单

- [ ] 创建了任务文件 `.ai-workspace/active/{task-id}/task.md`
- [ ] 创建了分析文档 `.ai-workspace/active/{task-id}/analysis.md`
- [ ] 更新了 task.md 中的 `current_step` 为 requirement-analysis
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 更新了 task.md 中的 `assigned_to`
- [ ] 在工作流进度中标记了 requirement-analysis 为已完成
- [ ] 告知了用户下一步（plan-task）
- [ ] **没有修改任何业务代码或配置文件**（仅 task.md 和 analysis.md）

## 停止

完成检查清单后，**立即停止**。不要继续执行计划、实现或任何后续步骤。
等待用户审查分析结果并手动调用 `plan-task` 技能。

## 注意事项

1. **清晰度**：如果用户描述模糊或缺少关键信息，先要求澄清
2. **与 analyze-issue 的区别**：`analyze-issue` 从 GitHub Issue 创建任务；`create-task` 从自由描述创建
3. **人工检查点**：分析完成是建议的审查点，建议在继续之前进行审查

## 错误处理

- 空描述：提示 "Please provide a task description"
- 描述过于模糊：在创建任务之前提出澄清问题
