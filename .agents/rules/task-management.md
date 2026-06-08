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
