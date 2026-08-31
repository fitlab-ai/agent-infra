---
name: analyze-task
description: >
  分析任务并输出需求分析文档。
  当需要在动手设计前厘清某个任务的需求、影响范围与风险时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
---

# 分析任务
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」。

若入口业务操作数包含 `--orchestrated`，绑定 `{execution-flag}` = `--orchestrated` 并原样转发给 completed 事件；否则绑定为空。不得从 `orchestration.json`、环境变量或历史产物推断该标记。

## 行为边界 / 关键规则

- 本技能仅产出需求分析文档（`analysis.md` 或 `analysis-r{N}.md`）—— 不修改任何业务代码
- 严格基于 `task.md` 中已有的任务输入、需求、上下文和来源信息展开分析
- 涉及旧行为、旧数据、旧 schema 或旧调用方时，先读取 `.agents/rules/compatibility-policy.md`；没有兼容准入证据时明确采用 current-only，不把推测写成需求
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并把原文粘贴到本轮产物的 `## 状态核对` 段：

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

状态核对完成前，禁止任何关于外部状态的断言（例如“代码没变”“测试已通过”“没有其他引用”），包括思考阶段。本门禁只提供结构下限；逐条证据配对和真实性仍需按报告模板与审查要求核对。

## 任务上下文解析

> 入口可省略 task ref；显式 task scope 仅接受 `--task <ref>` 或 `-t <ref>`，不再解释位置 task ref。保留其余业务操作数后调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

> 解析任务引用，并确认任务位于本技能支持的状态或目录且存在 `task.md`；无法定位时按未找到任务处理并停止。

## 步骤开始：声明 started 事件

确认前置条件和轮次后、本轮第一个产出动作之前执行：

```bash
agent-infra-internal task-event {task-id} analyze.started --agent {standard-agent-token}
```

## 执行步骤
### 1. 验证前置条件

检查必要文件：
- `.agents/workspace/active/{task-id}/task.md` - 任务文件

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果缺少 `task.md`，提示用户先创建或导入任务。

### 2. 解析分析上下文

运行 `agent-infra-internal task-artifact {task-id} inspect --family analysis`。仅当结果为 `ready` 时继续；从 `next.round` / `next.name` 记录 `{analysis-round}` / `{analysis-artifact}`，从 `inputs` 读取修订上下文。不得自行扫描轮次或拼装文件名。随后执行 started 事件，并以事件返回的 `artifactContext` 复核同一身份。

### 3. 阅读任务上下文

仔细阅读 `task.md` 以理解：
- `## 任务输入` 中已捕获的来源、事实与证据、约束、决策状态、验收标准和未决事项（栏目不存在时兼容回退）
- 任务标题、描述和需求列表
- 上下文信息（Issue、PR、分支、告警编号等）
- 当前已知的受影响文件和约束

如 `task.md` 包含以下来源字段，补充读取对应来源信息：
- `issue_number` - Issue
- `codescan_alert_number` - Code Scanning 告警
- `security_alert_number` - Dependabot 告警

**Round ≥ 2：响应上一轮审查（仅当存在审查产物时）**：若任务目录存在 `review-analysis.md` / `review-analysis-r{N}.md`，读取最高轮次的审查报告；在本轮分析产物中新增 `## 对上一轮审查的响应` 段，对每条发现先 Read/Grep 核实，再按 `.agents/rules/review-handshake.md` 的四态（`accepted` / `adjusted` / `refuted` / `cannot-judge`）处置——每态都要附相称证据，不默认顺从；随后逐条调用 `agent-infra-internal task-ledger {task-id} finding-respond --id {ledger-id} --round {analysis-round} --status {四态} --evidence {相称证据}`。未决分歧写入 `## 未决问题`。Round 1 无审查，跳过本段。

### 4. 入口需求充分性闸门

> 本步骤的发问受 `.agents/rules/no-mid-flow-questions.md`「例外 3：入口式需求充分性澄清」授权：仅在 analyze-task 入口、仅用于判断并补齐需求充分性，一次只问一个问题，**绝不**借此征求实现 / 技术选型偏好。

排在第 0 步状态核对与步骤 3 之后执行（提问属对外动作，须在状态核对硬闸门之后；判定与状态读写需先读到 task.md）。

**4.1 读取跨轮状态**：读取 task.md 的 `## Brainstorming` 段（不存在则视为首次，`question_count=0`）。段格式：

```
## Brainstorming
- status: asking | done
- question_count: <int>
- pending_question: <文本，可空>
- answered:
  - Q: … / A: …
```

**4.2 接收上一问的答案**：若存在 `pending_question`：
- 用户当轮消息可解析出答案 → 把答案回写 `## 描述` / `## 需求`，把该 `Q/A` 追加进 `answered`，清空 `pending_question`（`question_count` 不变）。
- 未携带答案 → 复述 `pending_question`，按下文场景 B 提问早退（不增加 `question_count`）。

**4.3 充分性判定**（客观清单，命中任一缺口即判为不足）：
- 先聚合 `## 任务输入`、描述、上下文、需求及远端来源；分析阶段尚未填写 `## 需求` 本身不构成不足；
- 已在任务输入中记录的目标、范围、约束或验收标准视为已提供，不得重复询问；
- 描述/需求为空，或仅一句话且无可验证的验收标准；
- 缺少目标或受影响范围（不知道要改什么 / 影响谁）；
- 需求条目自相矛盾，或关键名词未定义而无法分析。

**4.4 分流**：

- **场景 A（充分 / 已收敛）**——满足任一退出条件：充分性清单全部通过 / 用户显式「直接分析 / skip」/ `question_count` 达上限（≤5）。置 `## Brainstorming` 的 `status: done`，继续步骤 5 起的正常流程；未补齐的缺口写入分析产物 `## 假设` / `## 未决问题`。
- **场景 B（不足，提问早退）**——在本步骤内闭环并提前 STOP：
  1. 确定本轮要问的问题（与 4.2 保持一致）：
     - 若已存在 `pending_question`（上一问尚未得到答案）→ 复述该 `pending_question`，**不**修改它、**不**增加 `question_count`；
     - 否则（无待答问题）→ 选最高价值的一个问题（验收标准 > 范围 > 歧义），写入 `## Brainstorming`：`status: asking`、`pending_question: <问题>`、`question_count += 1`。
  2. 若 `start_date` 为空，写入当日日期（`date +%F`）；随后执行 `agent-infra-internal task-event {task-id} analyze.awaiting-input --agent {standard-agent-token} --question {question_count}`，由核心统一更新基础 frontmatter 和 Activity Log。
  3. Issue 同步（存在 `issue_number` 时，任一失败跳过）：调用 `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}` 更新 **task 评论**；`status` label 维持 `pending-design-work`；**不**发布分析产物评论。
  4. 校验（替代步骤 8 的 artifact gate）：`agent-infra-internal task-verify {task-id} analyze.awaiting-input --format text`（早退已置 `current_step: requirement-analysis` 且已写入 `start_date`，预期通过）；并保留 `rg -n 'Analyze Task \(Brainstorming\)' .agents/workspace/active/{task-id}/task.md` 与 task 评论同步证据。**不**跑 artifact gate，也不跑 `check activity-log` / `check platform-sync`（二者绑定分析产物路径）。
  5. 用户输出：只展示当前**单个问题** + 如何回答/继续（再次触发 `analyze-task {task-ref}` 并附答案），并按 `.agents/rules/next-step-output.md` 在末行追加 `Completed at`。
  6. **STOP**，等待回答。下一次触发回到本步骤。

### 5. 执行需求分析

开始分析前：若 frontmatter 的 `start_date` 为空，立即写入当日日期（命令 `date +%F`，格式 `YYYY-MM-DD`）；已有值则保留。写入前先读取 `.agents/rules/version-stamp.md`，并同步刷新 `updated_at` / `agent_infra_version`。

遵循 `.agents/workflows/feature-development.yaml` 中的 `analysis` 步骤：

**必要任务**（仅分析，不编写业务代码）：
- [ ] 理解任务需求和目标
- [ ] 搜索相关代码文件（**只读**）
- [ ] 分析代码结构和影响范围
- [ ] 识别潜在技术风险和依赖
- [ ] 评估工作量和复杂度

### 6. 输出分析文档

> 步骤 6–9 属**场景 A（正常产出）**路径。**场景 B（提问早退）**已在步骤 4 内完成状态更新、task 评论同步与校验并 STOP，不进入这些步骤。

创建 `.agents/workspace/active/{task-id}/{analysis-artifact}`。

## 输出模板

```markdown
# 需求分析报告

- **分析轮次**：Round {analysis-round}
- **产物文件**：`{analysis-artifact}`

## 状态核对

> 粘贴第 0 步状态核对命令原文；每条命令以 `$ ` 开头。

## 需求来源

**来源类型**：{用户描述 / Issue / Code Scanning / Dependabot / 其他}
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

## 假设

> 如本次分析依赖某些假设，列在此处；没有则可省略本段。

- {本轮分析所依赖的假设}

## 未决问题

> 如有需要人工裁定的未决问题，列在此处；没有则可省略本段。
> 普通未决问题列在本段；属关键设计决策的（按 `.agents/rules/no-mid-flow-questions.md` 判据），详情块改写入下方 `## 人工裁决待办` 的 `### HD-N`，本段仅保留一行指针。

- {未决问题}

## 人工裁决待办

> 仅当本轮升级了 `[needs-human-decision]` 关键设计决策时写本段；没有则省略。
> 每项先调用 `agent-infra-internal task-ledger {task-id} decision-next-id` 取得 `HD-N`，按 `.agents/rules/human-decision-context.md` 写自足 `### HD-N` 块，再调用 `decision-upsert --id {HD-N} --stage analysis --artifact {analysis-artifact}`；不得扫描编号或手写账本行。

## 工作量和复杂度评估
- 复杂度：{高/中/低}
- 风险等级：{高/中/低}
```

### 7. 更新任务状态

更新 `.agents/workspace/active/{task-id}/task.md`：
- 仅更新优先级、Brainstorming、审查响应等本技能拥有的业务内容；产物链接、阶段与完成日志由 completed 事件统一登记
- 在追加工作流 Activity Log 条目之前，基于分析结果（业务影响、风险、依赖、阻塞条件）重估 `priority`。若重估值与 `task.md` 当前值不一致：
  - 用新值覆盖 frontmatter 的 `priority` 字段
  - 在本轮分析产物 `{analysis-artifact}` 中追加 `## 优先级重估` 段，记录一条：`priority {old} → {new} (rationale: {基于本轮分析的简短依据})`
  若重估值与当前值一致，跳过：不写入 `## 优先级重估` 段。后续 Flow A 同步会读取可能更新过的 frontmatter，并自动把新值同步到 Issue。
- 完成业务内容更新后执行 `agent-infra-internal task-event {task-id} analyze.completed --agent {standard-agent-token} --artifact {analysis-artifact} {execution-flag}`，由核心原子登记链接、阶段、代理、时间、版本和 Activity Log。

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续）：
- 调用 `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --status pending-design-work --fields`
- 调用 `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`
- 调用 `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {analysis-artifact} --agent {standard-agent-token}`

### 8. 完成校验

> 本步骤的 artifact gate 仅用于**场景 A**；场景 B 的校验见步骤 4（`check task-meta` + 显式证据），不在此跑 artifact gate。

运行完成校验，确认任务产物和同步状态符合规范：

```bash
agent-infra-internal task-verify {task-id} analyze.completed --artifact {analysis-artifact} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 9. 告知用户

> 本步骤为**场景 A** 正常完成输出；场景 B 的单问输出见步骤 4。

> 仅在校验通过后执行本步骤。

> 状态核对的完整原始输出仅写入本轮产物。成功路径的用户消息只报告核对结果、必要摘要和产物路径，不重复展开完整快照；状态核对失败、发现异常或用户明确要求详情时，可展示相称的诊断信息。完成校验输出仍按本技能要求保留。

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

输出格式：
使用 `agent-infra-internal agent-client next-steps --skill review-analysis --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

```
任务 {task-id} 分析完成。

摘要：
- 分析轮次：Round {analysis-round}
- 相关文件：{数量}
- 风险等级：{评估}

产出文件：
- 分析报告：.agents/workspace/active/{task-id}/{analysis-artifact}

下一步 - 审查需求分析：
{next-step-commands}
```

## 完成检查清单

- [ ] 阅读并理解了任务文件和来源信息
- [ ] 创建了分析文档 `.agents/workspace/active/{task-id}/{analysis-artifact}`
- [ ] 更新了 task.md 中的 `current_step` 为 requirement-analysis
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 更新了 task.md 中的 `assigned_to`
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 在工作流进度中标记了 requirement-analysis 为已完成
- [ ] 已通过统一 helper 渲染已选场景的下一步命令
- [ ] **没有修改任何业务代码**

## 停止

完成检查清单后，**立即停止**。等待用户审查分析结果并手动调用 `plan-task` 技能。

## 注意事项

1. **前置条件**：必须已存在任务文件 `task.md`
2. **多轮分析**：需求变化或已有分析需要修订时，使用 `analysis-r{N}.md`
3. **职责单一**：本技能只负责分析，不设计方案、不实现代码

## 错误处理

- 任务未找到：提示 "Task {task-id} not found, please check the task ID"
