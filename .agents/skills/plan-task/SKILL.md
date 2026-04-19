---
name: plan-task
description: "为任务设计技术方案和实施计划"
---

# 设计技术方案

## 行为边界 / 关键规则

- 本技能仅产出技术方案文档（`plan.md` 或 `plan-r{N}.md`）—— 不修改任何业务代码
- 这是一个**强制性的人工审查检查点** —— 不要自动进入实现阶段
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

## 执行步骤

### 1. 验证前置条件

检查必要文件：
- `.agents/workspace/active/{task-id}/task.md` - 任务文件
- 至少一个分析产物：`analysis.md` 或 `analysis-r{N}.md`

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果任一文件缺失，提示用户先完成前置步骤。

### 2. 确定方案轮次

扫描 `.agents/workspace/active/{task-id}/` 目录中的方案产物文件：
- 如果不存在 `plan.md` 且不存在 `plan-r*.md` → 本轮为第 1 轮，产出 `plan.md`
- 如果存在 `plan.md` 且不存在 `plan-r*.md` → 本轮为第 2 轮，产出 `plan-r2.md`
- 如果存在 `plan-r{N}.md` → 本轮为第 N+1 轮，产出 `plan-r{N+1}.md`

记录：
- `{plan-round}`：本轮方案轮次
- `{plan-artifact}`：本轮方案产物文件名

### 3. 阅读需求分析

扫描任务目录中的分析产物文件（`analysis.md`、`analysis-r{N}.md`）：
- 如果存在 `analysis-r{N}.md`，读取最高 N 的文件
- 否则读取 `analysis.md`
以理解：
- 需求及其背景
- 相关文件和代码结构
- 影响范围和依赖关系
- 已识别的技术风险
- 工作量和复杂度评估

### 4. 理解问题

- 阅读分析中识别的相关源码文件
- 理解当前架构和模式
- 识别约束条件（向后兼容性、性能等）
- 考虑边界情况和错误场景

### 5. 设计技术方案

遵循 `.agents/workflows/feature-development.yaml` 中的 `technical-design` 步骤：

**必要任务**：
- [ ] 定义技术方法和理由
- [ ] 考虑备选方案并说明权衡
- [ ] 按顺序详细列出实施步骤
- [ ] 列出所有需要创建/修改的文件
- [ ] 定义验证策略（测试、手动检查）
- [ ] 评估方案的影响和风险

**设计原则**：
1. **架构合理性**：选择结构正确的方案，改动大小不是首要依据。不要为了减少 diff 而在不合理的结构上叠加
2. **简洁性**：在架构合理的前提下，优先选择最简方案，避免过度设计
3. **一致性**：遵循现有代码模式和规范
4. **可测试性**：设计易于测试的方案
5. **可逆性**：优先选择易于回退的变更

### 6. 输出计划文档

创建 `.agents/workspace/active/{task-id}/{plan-artifact}`。

### 7. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `current_step`：technical-design
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- 记录本轮方案产物：`{plan-artifact}`（Round `{plan-round}`）
- 如任务模板包含 `## 设计` 段落，更新为指向 `{plan-artifact}` 的链接
- 在工作流进度中标记 technical-design 为已完成，并注明实际轮次（如果任务模板支持）
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Technical Design (Round {N})** by {agent} — Plan completed, awaiting human review → {artifact-filename}
  ```

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续）：
- 执行前先读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测
- 按 issue-sync.md 设置 `status: pending-design-work`
- 创建或更新 `<!-- sync-issue:{task-id}:task -->` 评论（按 issue-sync.md 的 task.md 评论同步规则）
- 发布 `{plan-artifact}` 评论

### 8. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate plan-task .agents/workspace/active/{task-id} {plan-artifact} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 9. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

输出格式：
```
任务 {task-id} 技术方案完成。

方案概要：
- 轮次：Round {plan-round}
- 方法：{简要描述}
- 需修改文件：{数量}
- 需新建文件：{数量}
- 预估复杂度：{评估}

产出文件：
- 技术方案：.agents/workspace/active/{task-id}/{plan-artifact}

重要：人工审查检查点。
请在继续实现之前审查技术方案。

下一步 - 实施任务：
  - Claude Code / OpenCode：/implement-task {task-id}
  - Gemini CLI：/agent-infra:implement-task {task-id}
  - Codex CLI：$implement-task {task-id}
```

## 完成检查清单

- [ ] 阅读并理解了需求分析
- [ ] 考虑了备选方案
- [ ] 创建了计划文档 `.agents/workspace/active/{task-id}/{plan-artifact}`
- [ ] 更新了 task.md 中的 `current_step` 为 technical-design
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 在 task.md 中记录了 `{plan-artifact}` 为已完成产物
- [ ] 在工作流进度中标记了 technical-design 为已完成
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 告知了用户这是人工审查检查点
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，不要筛选）

## 停止

完成检查清单后，**立即停止**。
这是一个**强制性的人工审查检查点** —— 用户必须审查并批准计划后才能继续实现。

## 注意事项

1. **前置条件**：必须已完成至少一轮需求分析（`analysis.md` 或 `analysis-r{N}.md` 存在）
2. **人工审查**：这是强制性检查点 —— 不要自动进入实现阶段
3. **计划质量**：计划应足够具体，使另一个 AI 代理无需额外上下文即可实现
4. **版本化规则**：首轮方案使用 `plan.md`；后续修订使用 `plan-r{N}.md`

## 错误处理

- 任务未找到：提示 "Task {task-id} not found, please check the task ID"
- 缺少分析：提示 "Analysis not found, please run the analyze-task skill first"
