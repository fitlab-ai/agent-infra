---
name: plan-task
description: >
  为任务设计技术方案和实施计划。
  当需求已明确、需要在编码前形成技术方案时使用。
---

# 设计技术方案

## 行为边界 / 关键规则

- 本技能仅产出技术方案文档（`plan.md` 或 `plan-r{N}.md`）—— 不修改任何业务代码
- 这是一个**强制性的人工审查检查点** —— 不要自动进入实现阶段
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并把原文粘贴到回复正文和本轮产物的 `## 状态核对` 段：

```bash
git status -s
ls -la .agents/workspace/active/{task-id}/
tail .agents/workspace/active/{task-id}/task.md
```

状态核对完成前，禁止任何关于外部状态的断言（例如“代码没变”“测试已通过”“没有其他引用”），包括思考阶段。本门禁只提供结构下限；逐条证据配对和真实性仍需按报告模板与审查要求核对。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：写入 started 标记

确认前置条件后、本轮第一个产出动作之前，向 task.md `## 活动日志` 追加一条 started 标记（与本轮 done 条目同基名 + ` [started]` 后缀，note 用 `started`）：

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Plan Task (Round {N}) [started]** by {agent} — started
```

`ai task log` 会把它与步骤完成时（步骤 7）写入的 done 条目配对成一行（进行中 → 已完成）。格式与配对规则见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

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

**Round ≥ 2：响应上一轮审查（仅当存在审查产物时）**：若任务目录存在 `review-plan.md` / `review-plan-r{N}.md`，读取最高轮次的审查报告；在本轮方案产物中新增 `## 对上一轮审查的响应` 段，对每条发现先 Read/Grep 核实，再按 `.agents/rules/review-handshake.md` 的四态（`accepted` / `adjusted` / `refuted` / `cannot-judge`）处置——每态都要附相称证据，不默认顺从；并把处置回写 task.md `## 审查分歧账本` 对应行（stage=plan，round +1）。未决分歧写入 `## 未决问题`。Round 1 无审查，跳过本段。

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

遇到本轮新增的关键设计决策时，按 `.agents/rules/no-mid-flow-questions.md` 判据，把详情块（背景/选项/影响/推荐）写入方案产物的 `## 人工裁决待办` 段 `### HD-N：<标题> [needs-human-decision]`（`HD-N` 全局唯一，规则见 `.agents/rules/review-handshake.md`），并回写 `HD-` 账本行（evidence 指向 `{plan-artifact}#HD-N`）；普通未决问题仍写 `## 未决问题`。

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
- `agent_infra_version`：按 `.agents/rules/version-stamp.md` 取值
- 记录本轮方案产物：`{plan-artifact}`（Round `{plan-round}`）
- 如任务模板包含 `## 设计` 段落，更新为指向 `{plan-artifact}` 的链接
- 在工作流进度中标记 technical-design 为已完成，并注明实际轮次（如果任务模板支持）
- 在追加工作流 Activity Log 条目之前，基于技术方案（实施步骤数、涉及文件、测试矩阵范围、集成面）重估 `effort`。若重估值与 `task.md` 当前值不一致：
  - 用新值覆盖 frontmatter 的 `effort` 字段
  - 在本轮方案产物 `{plan-artifact}` 中追加 `## 工作量重估` 段，记录一条：`effort {old} → {new} (rationale: {基于本轮方案的简短依据})`
  若重估值与当前值一致，跳过：不写入 `## 工作量重估` 段。后续 Flow A 同步会读取可能更新过的 frontmatter，并自动把新值同步到 Issue。
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Plan Task (Round {N})** by {agent} — Plan completed, awaiting human review → {artifact-filename}
  ```

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续）：
- 执行前先读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测
- 按 issue-sync.md 设置 `status: pending-design-work`
- 创建或更新 `.agents/rules/issue-sync.md` 中定义的 task 评论标记（按 issue-sync.md 的 task.md 评论同步规则）
- 发布 `{plan-artifact}` 评论
- 读取 `.agents/rules/issue-fields.md`，按流程 A 把 `task.md` 中所有非空的 Issue 字段（`priority`/`effort`/`start_date`/`target_date`）同步到 Issue（幂等；`has_push=false` 或取数/写入失败时跳过，不阻断）

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

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。 渲染最终输出前，先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令把 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

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

下一步 - 审查技术方案：
  - Claude Code / OpenCode：/review-plan {task-ref}
  - Gemini CLI：/agent-infra:review-plan {task-ref}
  - Codex CLI：$review-plan {task-ref}
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
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，含自定义 TUI，不要筛选）

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
