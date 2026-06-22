# 通用规则 - 任务管理

## 任务语义识别

根据用户意图自动映射到对应工作流命令：
- “分析 issue #123” -> `import-issue`
- “分析任务 TASK-20260306-143022” -> `analyze-task`
- “审查需求分析” -> `review-analysis`
- “设计方案” -> `plan-task`
- “审查方案/审查技术方案” -> `review-plan`
- “实施/实现” -> `code-task`
- “审查代码/代码审查” -> `review-code`
- “修复审查问题” -> `code-task`

## 任务状态管理

- 每次执行工作流命令后，必须立即更新对应任务的 `task.md`
- 至少同步 `current_step`、`updated_at`、`assigned_to`、`agent_infra_version`，以及本轮产物引用
- 更新 `agent_infra_version` 前，先读取 `.agents/rules/version-stamp.md`
- Activity Log 只能追加，不能覆盖历史记录

## 常见命令的状态更新要求

- `create-task`：创建 `branch`、`workflow`、`status`、`created_at`、`updated_at`、`assigned_to`、`agent_infra_version`
- `import-issue`：更新 `current_step`、`updated_at`、`assigned_to`、`agent_infra_version`
- `import-codescan`：更新 `current_step`、`updated_at`、`assigned_to`、`agent_infra_version`
- `import-dependabot`：更新 `current_step`、`updated_at`、`assigned_to`、`agent_infra_version`
- `restore-task`：更新 `status`、`updated_at`、`assigned_to`、`agent_infra_version`
- `analyze-task`：更新 `current_step`、`updated_at`、`assigned_to`、`agent_infra_version`
- `review-analysis`：更新 `current_step`、`updated_at`、`agent_infra_version`
- `plan-task`：更新 `current_step`、`updated_at`、`agent_infra_version`
- `review-plan`：更新 `current_step`、`updated_at`、`agent_infra_version`
- `code-task`：更新 `current_step`、`updated_at`、`agent_infra_version`
- `review-code`：更新 `current_step`、`updated_at`、`agent_infra_version`
- `create-pr`：更新 `pr_number`、`updated_at`、`agent_infra_version`
- `commit`：更新 `updated_at`、`agent_infra_version`；必要时更新 `current_step`（详见 `commit/reference/task-status-update.md`）
- `complete-task`：更新 `status`、`current_step`、`completed_at`、`updated_at`、`agent_infra_version`
- `block-task`：更新 `status`、`blocked_at`、`blocked_reason`、`updated_at`、`agent_infra_version`
- `cancel-task`：更新 `status`、`cancelled_at`、`cancel_reason`、`updated_at`、`agent_infra_version`

## Activity Log started / done 双标记约定（单一事实源）

> 本节是 started/done 双标记的唯一权威定义。各 SKILL、渲染器（`lib/task/commands/log.ts`）、
> 校验脚本（`.agents/scripts/validate-artifact.js`）的相关行为都以本节为准；改动任一端时同步本节。

**行语法不变**：started 与 done 都沿用既有条目语法
`- {YYYY-MM-DD HH:mm:ss±HH:MM} — **{action}** by {agent} — {note}`，因此解析正则
（`log.ts:ENTRY_RE` 与 `validate-artifact.js:ACTIVITY_LOG_PATTERN`）无需改动。

- **started 行**（步骤开始时写）：action 在既有基名末尾加后缀 ` [started]`，note 用 `started`：
  `- {time} — **{基名} [started]** by {agent} — started`
- **done 行**（步骤完成时写，与现状一致）：action 即基名本身：
  `- {time} — **{基名}** by {agent} — {完成说明}`
- `{基名}` 指该 SKILL 既有 done 条目的 action 文本，含 `(Round {N})`（如 `Plan Task (Round 1)`）。
  started 与 done 共用同一 `{基名}` 才能配对。

**配对与渲染**（`ai task log`）：按 `{基名}` 把 started 与其后最近的同名 done 配成一行（同基名多次执行按时间升序 FIFO 配对）。STARTED 列显示 started 时间、DONE 列显示 done 时间；只有 started 无 done = 进行中（DONE 显示 `(in progress)`）；只有 done 无 started（历史日志）= 单态完成行。三种形态都合法、不报错。

**gate**（`checkActivityLog`）：计算「最新 action / freshness」时跳过 `[started]` 行（升序与格式校验仍覆盖全部行），故 started 标记不会污染各 SKILL 的 `expected_action_pattern`。

**写 started 的 SKILL**（仅这些工作流 SKILL，在「该轮实质工作开始时」追加 started 标记）：
`analyze-task`、`plan-task`、`code-task`、`review-analysis`、`review-plan`、`review-code`、`commit`、`complete-task`。
瞬时型生命周期 SKILL（`create-task`/`import-*`/`block-task`/`cancel-task`/`restore-task`/`close-*`/`create-pr`）开始即结束，**不写** started。
