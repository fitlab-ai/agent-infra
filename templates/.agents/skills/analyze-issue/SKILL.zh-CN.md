---
name: analyze-issue
description: >
  分析 GitHub Issue 并创建任务文件和需求分析文档。
  当用户要求分析某个 Issue 时触发。参数：issue 编号。
---

# 分析 Issue

分析指定的 GitHub Issue 并创建任务及需求分析。参数：issue 编号。

## 关键：行为边界

**本技能的唯一产出是 `task.md` 和 `analysis.md`。**
不要编写或修改业务代码。仅做分析。

## 关键：状态更新要求

执行本技能后，你**必须**立即更新任务状态。

## 执行流程

### 1. 获取 Issue 信息

```bash
gh issue view <issue-number> --json number,title,body,labels
```

提取：issue 编号、标题、描述、标签。

### 2. 检查已有任务

搜索 `.ai-workspace/active/` 中是否已有链接到此 Issue 的任务。
- 如果找到，询问用户是重新分析还是继续使用现有分析
- 如果未找到，创建新任务

### 3. 创建任务目录和文件

```bash
date +%Y%m%d-%H%M%S
```

- 创建目录：`.ai-workspace/active/TASK-{yyyyMMdd-HHmmss}/`
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
assigned_to: ai
```

### 4. 执行需求分析

遵循 `.agents/workflows/feature-development.yaml` 中的 `requirement-analysis` 步骤：

**必要任务**（只读，不编写业务代码）：
- [ ] 阅读并理解 Issue 描述
- [ ] 搜索相关代码文件
- [ ] 分析代码结构和影响范围
- [ ] 识别潜在技术风险和依赖
- [ ] 评估工作量和复杂度

### 5. 输出分析文档

创建 `.ai-workspace/active/{task-id}/analysis.md`：

```markdown
# 需求分析报告

## 需求理解
{用自己的话重述 Issue 需求}

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
- {需要的依赖和协调}

## 工作量和复杂度评估
- 复杂度：{高/中/低}
- 工作量：{预估时间}
- 风险等级：{高/中/低}
```

### 6. 更新任务状态

更新 `.ai-workspace/active/{task-id}/task.md`：
- `current_step`：requirement-analysis
- `assigned_to`：ai
- `updated_at`：{当前时间}
- 标记 analysis.md 为已完成
- 在工作流进度中标记 requirement-analysis 为已完成

### 7. 告知用户

```
Issue #{number} analysis complete.

Task info:
- Task ID: {task-id}
- Title: {title}
- Workflow: {workflow}

Output files:
- Task file: .ai-workspace/active/{task-id}/task.md
- Analysis: .ai-workspace/active/{task-id}/analysis.md

Next step - review analysis, then execute the plan-task skill with {task-id}.
```

## 完成检查清单

- [ ] 创建了任务文件 `.ai-workspace/active/{task-id}/task.md`
- [ ] 创建了分析文档 `.ai-workspace/active/{task-id}/analysis.md`
- [ ] 在 task.md 中记录了 issue_number
- [ ] 更新了 `current_step` 为 requirement-analysis
- [ ] 更新了 `updated_at` 为当前时间
- [ ] 在工作流进度中标记了 requirement-analysis 为已完成
- [ ] 告知了用户下一步（plan-task 技能）
- [ ] **没有修改任何业务代码**

## 停止

完成检查清单后，**立即停止**。不要继续执行后续步骤。

## 注意事项

1. **Issue 验证**：在继续之前检查 Issue 是否存在
2. **重复任务**：如果此 Issue 已有关联任务，在创建新任务前询问用户
3. **人工检查点**：分析完成是建议的审查点

## 错误处理

- Issue 未找到：提示 "Issue #{number} not found, please check the issue number"
- 网络错误：提示 "Cannot connect to GitHub, please check network"
- 权限错误：提示 "No access to this repository"
