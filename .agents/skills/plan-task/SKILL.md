---
name: plan-task
description: >
  为任务设计技术方案和实施计划。
  当需求已明确、需要在编码前形成技术方案时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
---

# 设计技术方案
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」：标准 AI 短名（`claude`/`codex`/`antigravity`/`opencode`/`cursor`）、长名归一化（`claude-code`→`claude`、`antigravity-cli`→`antigravity`）或人工例外 `human`。


## 行为边界 / 关键规则

- 本技能仅产出技术方案文档（`plan.md` 或 `plan-r{N}.md`）—— 不修改任何业务代码
- 这是一个**强制性的人工审查检查点** —— 不要自动进入实现阶段
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并把原文粘贴到回复正文和本轮产物的 `## 状态核对` 段：

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

状态核对完成前，禁止任何关于外部状态的断言（例如“代码没变”“测试已通过”“没有其他引用”），包括思考阶段。本门禁只提供结构下限；逐条证据配对和真实性仍需按报告模板与审查要求核对。

## 任务上下文解析

> 入口允许省略 task ref，也接受旧位置 task ref 或 `--task <ref>` / `-t <ref>`。先从完整参数中分离 task scope 并原样保留其他业务操作数，再调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空、位置 ref 或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为该完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

> 解析任务引用，并确认任务位于本技能支持的状态或目录且存在 `task.md`；无法定位时按未找到任务处理并停止。

## 步骤开始：声明 started 事件

确认前置条件和轮次后、本轮第一个产出动作之前执行：

```bash
agent-infra-internal task-event {task-id} plan.started --agent {standard-agent-token}
```

## 执行步骤
### 1. 验证前置条件

检查必要文件：
- `.agents/workspace/active/{task-id}/task.md` - 任务文件
- 至少一个分析产物：`analysis.md` 或 `analysis-r{N}.md`

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果任一文件缺失，提示用户先完成前置步骤。

### 2. 解析方案上下文

运行 `agent-infra-internal task-artifact {task-id} inspect --family plan`。仅当结果为 `ready` 时继续；从 `inputs` 取得最新 `{analysis-artifact}`，从 `next.round` / `next.name` 取得 `{plan-round}` / `{plan-artifact}`。不得自行扫描轮次或拼装文件名。随后执行 started 事件并复核返回身份。

### 3. 阅读需求分析

读取步骤 2 核心返回的最新 `{analysis-artifact}`，
以理解：
- 需求及其背景
- 相关文件和代码结构
- 影响范围和依赖关系
- 已识别的技术风险
- 工作量和复杂度评估

**Round ≥ 2：响应上一轮审查（仅当存在审查产物时）**：若任务目录存在 `review-plan.md` / `review-plan-r{N}.md`，读取最高轮次的审查报告；在本轮方案产物中新增 `## 对上一轮审查的响应` 段，对每条发现先 Read/Grep 核实，再按 `.agents/rules/review-handshake.md` 的四态（`accepted` / `adjusted` / `refuted` / `cannot-judge`）处置——每态都要附相称证据，不默认顺从；随后逐条调用 `agent-infra-internal task-ledger {task-id} finding-respond --id {ledger-id} --round {plan-round} --status {四态} --evidence {相称证据}`。未决分歧写入 `## 未决问题`。Round 1 无审查，跳过本段。

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

遇到本轮新增的关键设计决策时，按 `.agents/rules/no-mid-flow-questions.md` 判据，先调用 `agent-infra-internal task-ledger {task-id} decision-next-id` 取得 `HD-N`，按 `.agents/rules/human-decision-context.md` 写入方案产物的 `## 人工裁决待办` 段 `### HD-N：<标题> [needs-human-decision]`，再调用 `decision-upsert --id {HD-N} --stage plan --artifact {plan-artifact}`；普通未决问题仍写 `## 未决问题`。

**设计原则**：
1. **架构合理性**：选择结构正确的方案，改动大小不是首要依据。不要为了减少 diff 而在不合理的结构上叠加
2. **简洁性**：在架构合理的前提下，优先选择最简方案，避免过度设计
3. **一致性**：遵循现有代码模式和规范
4. **可测试性**：设计易于测试的方案
5. **可逆性**：优先选择易于回退的变更

### 6. 输出计划文档

创建 `.agents/workspace/active/{task-id}/{plan-artifact}`。

### 7. 更新任务状态

更新 `.agents/workspace/active/{task-id}/task.md`：
- 仅更新工作量、审查响应等本技能拥有的业务内容；产物链接、阶段与完成日志由 completed 事件统一登记
- 在追加工作流 Activity Log 条目之前，基于技术方案（实施步骤数、涉及文件、测试矩阵范围、集成面）重估 `effort`。若重估值与 `task.md` 当前值不一致：
  - 用新值覆盖 frontmatter 的 `effort` 字段
  - 在本轮方案产物 `{plan-artifact}` 中追加 `## 工作量重估` 段，记录一条：`effort {old} → {new} (rationale: {基于本轮方案的简短依据})`
  若重估值与当前值一致，跳过：不写入 `## 工作量重估` 段。后续 Flow A 同步会读取可能更新过的 frontmatter，并自动把新值同步到 Issue。
- 完成业务内容更新后执行 `agent-infra-internal task-event {task-id} plan.completed --agent {standard-agent-token} --artifact {plan-artifact}`，由核心原子登记链接、阶段、代理、时间、版本和 Activity Log。

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续）：
- 调用 `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --status pending-design-work --fields`
- 调用 `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`
- 调用 `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {plan-artifact} --agent {standard-agent-token}`

### 8. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
agent-infra-internal task-verify {task-id} plan.completed --artifact {plan-artifact} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 9. 告知用户

> 仅在校验通过后执行本步骤。

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

输出格式：
使用 `agent-infra-internal agent-client next-steps --skill review-plan --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

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
{next-step-commands}
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
- [ ] 已通过统一 helper 渲染已选场景的下一步命令

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
