---
name: analyze-task
description: "分析任务并输出需求分析文档"
---

# 分析任务

## 行为边界 / 关键规则

- 本技能仅产出需求分析文档（`analysis.md` 或 `analysis-r{N}.md`）—— 不修改任何业务代码
- 严格基于 `task.md` 中已有的需求、上下文和来源信息展开分析
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

## 执行步骤

### 1. 验证前置条件

检查必要文件：
- `.agents/workspace/active/{task-id}/task.md` - 任务文件

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果缺少 `task.md`，提示用户先创建或导入任务。

### 2. 确定分析轮次

扫描 `.agents/workspace/active/{task-id}/` 目录中的分析产物文件：
- 如果不存在 `analysis.md` 且不存在 `analysis-r*.md` → 本轮为第 1 轮，产出 `analysis.md`
- 如果存在 `analysis.md` 且不存在 `analysis-r*.md` → 本轮为第 2 轮，产出 `analysis-r2.md`
- 如果存在 `analysis-r{N}.md` → 本轮为第 N+1 轮，产出 `analysis-r{N+1}.md`

记录：
- `{analysis-round}`：本轮分析轮次
- `{analysis-artifact}`：本轮分析产物文件名

### 3. 阅读任务上下文

仔细阅读 `task.md` 以理解：
- 任务标题、描述和需求列表
- 上下文信息（Issue、PR、分支、告警编号等）
- 当前已知的受影响文件和约束

如 `task.md` 包含以下来源字段，补充读取对应来源信息：
- `issue_number` - GitHub Issue
- `codescan_alert_number` - Code Scanning 告警
- `security_alert_number` - Dependabot 告警

### 4. 执行需求分析

遵循 `.agents/workflows/feature-development.yaml` 中的 `analysis` 步骤：

**必要任务**（仅分析，不编写业务代码）：
- [ ] 理解任务需求和目标
- [ ] 搜索相关代码文件（**只读**）
- [ ] 分析代码结构和影响范围
- [ ] 识别潜在技术风险和依赖
- [ ] 评估工作量和复杂度

### 5. 输出分析文档

创建 `.agents/workspace/active/{task-id}/{analysis-artifact}`。

## 输出模板

```markdown
# 需求分析报告

- **分析轮次**：Round {analysis-round}
- **产物文件**：`{analysis-artifact}`

## 需求来源

**来源类型**：{用户描述 / GitHub Issue / Code Scanning / Dependabot / 其他}
**来源摘要**：
> {任务来源或关键上下文}

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

### 6. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `current_step`：requirement-analysis
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- 记录本轮分析产物：`{analysis-artifact}`（Round `{analysis-round}`）
- 如任务模板包含 `## 分析` 段落，更新为指向 `{analysis-artifact}` 的链接
- 在工作流进度中标记 requirement-analysis 为已完成，并注明实际轮次（如果任务模板支持）
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Requirement Analysis (Round {N})** by {agent} — Analysis completed → {analysis-artifact}
  ```

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续）：
- 执行前先读取 `.agents/rules/issue-sync.md`
- 设置 `status: pending-design-work`
- 发布 `{analysis-artifact}` 评论

### 7. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate analyze-task .agents/workspace/active/{task-id} {analysis-artifact} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 8. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

输出格式：
```
任务 {task-id} 分析完成。

摘要：
- 分析轮次：Round {analysis-round}
- 相关文件：{数量}
- 风险等级：{评估}

产出文件：
- 分析报告：.agents/workspace/active/{task-id}/{analysis-artifact}

下一步 - 设计技术方案：
  - Claude Code / OpenCode：/plan-task {task-id}
  - Gemini CLI：/agent-infra:plan-task {task-id}
  - Codex CLI：$plan-task {task-id}
```

## 完成检查清单

- [ ] 阅读并理解了任务文件和来源信息
- [ ] 创建了分析文档 `.agents/workspace/active/{task-id}/{analysis-artifact}`
- [ ] 更新了 task.md 中的 `current_step` 为 requirement-analysis
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 更新了 task.md 中的 `assigned_to`
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 在工作流进度中标记了 requirement-analysis 为已完成
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，不要筛选）
- [ ] **没有修改任何业务代码**

## 停止

完成检查清单后，**立即停止**。等待用户审查分析结果并手动调用 `plan-task` 技能。

## 注意事项

1. **前置条件**：必须已存在任务文件 `task.md`
2. **多轮分析**：需求变化或已有分析需要修订时，使用 `analysis-r{N}.md`
3. **职责单一**：本技能只负责分析，不设计方案、不实现代码

## 错误处理

- 任务未找到：提示 "Task {task-id} not found, please check the task ID"
