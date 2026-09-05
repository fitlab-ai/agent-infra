---
id: task-XXX
type: feature                  # feature | bugfix | refactor | docs | chore
branch:                        # <project>-<type>-<slug>
workflow: feature-development  # feature-development | bug-fix | refactoring
status: active                 # active | blocked | completed
created_at: YYYY-MM-DDTHH:mm:ss±HH:MM
updated_at: YYYY-MM-DDTHH:mm:ss±HH:MM
agent_infra_version: v0.0.0    # 当前 agent-infra 版本；由工作流命令刷新
priority:                       # 可选 Issue 字段：Urgent | High | Medium | Low
effort:                         # 可选 Issue 字段：High | Medium | Low
start_date:                     # Feature 可选 Issue 字段：YYYY-MM-DD
target_date:                    # Feature 可选 Issue 字段：YYYY-MM-DD
current_step: requirement-analysis # requirement-analysis | requirement-analysis-review | technical-design | technical-design-review | code | code-review | completed
assigned_to:                   # claude | codex | antigravity | opencode | human
pr_delivery_fact: '{"version":1,"state":"unbound","reason":"initial"}'
delivery_remote: origin        # 任务分支交付使用的 Git remote
delivery_base_ref: main        # 任务 PR 的目标分支
checkpoint_commit:             # 最近一次本地 checkpoint commit
delivery_remote_head:          # 最近一次成功交付到 remote 的任务分支 SHA
---

# 任务：[标题]

## 描述

[清晰简洁地描述任务。]

## 任务输入

<!-- 由 create-task 忠实记录当前请求及必要前序讨论中已有的信息；缺失项保持为空，不推导补齐。 -->

### 来源

### 已确认事实与证据

### 约束

| constraint_id | statement | status | authority | source | evidence | derived_from | approval_evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |

### 已确认决策

### 候选与否决方案

| candidate_id | statement | status | constraint_ids | impact | evidence |
| --- | --- | --- | --- | --- | --- |

### 验收标准

### 未决事项

## 上下文

- **关联 Issue**：#XXX
- **关联 PR**：#XXX
- **分支**：`feature/xxx`

## 需求

<!-- 由 analyze-task 填写 -->

## 分析

[分析阶段的发现。哪些文件受影响？范围是什么？]

### 受影响的文件

- `path/to/file1` - 变更描述
- `path/to/file2` - 变更描述

## 设计

[技术方案。接口、数据流、架构决策。]

## 实现备注

[实现阶段的备注。做出的决策、权衡、与设计的偏差。]

## 审查反馈

<!-- 由 review-* 填写 -->

## 审查分歧账本

<!-- 每条 review finding 一行；状态机/证据规则见 .agents/rules/review-handshake.md。阶段推进与 complete-task gate 读取本段。无分歧时保留表头即可。 -->

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|

## 人工裁决

<!-- 使用 ai decide [--task <ref> | -t <ref>] (--item <序号|账本ID> | -i <序号|账本ID>) [--needs-implementation true|false] <裁决内容> 写入 needs-human-decision 裁定；新建 code 裁决的实现意图由上游 AI 预先声明，显式参数仅用于历史任务兼容或一致性复核。 -->

## 实现输入

| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |
|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|

## 工作流告警

<!-- 工作流降级、平台同步失败、权限不足等需要后续注意的事件写入此段。无告警时保留表头即可。 -->

| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |
|----|------|------|----------|------|--------|---------|--------|-------------|------------|------------|

## 返工意图

| intent_id | finding_id | source_artifact | source_sha256 | target | status | declared_at | consumed_at |
|-----------|------------|----------------|---------------|--------|--------|-------------|-------------|

## 产物失效记录

### Operations

| operation_id | source_family | source_artifact | source_round | source_sha256 | status | processed | total | created_at | updated_at | completed_at | error |
|--------------|---------------|-----------------|--------------|---------------|--------|-----------|-------|------------|------------|--------------|-------|

### Targets

| target_id | operation_id | target_kind | target_family | target_artifact | target_round | target_sha256 | status | reason_code | updated_at |
|-----------|--------------|-------------|---------------|-----------------|--------------|---------------|--------|-------------|------------|

## 活动日志

<!-- 每个工作流步骤追加一条新记录，不要覆盖之前的记录。 -->
<!-- 格式：- {YYYY-MM-DD HH:mm:ss±HH:MM} — **{步骤}** by {执行者} — {简要说明} -->
<!-- 部分工作流 SKILL 在步骤开始时额外写一条 started 标记（action 末尾加 ` [started]`），完成时再写 done；ai task log 会按基名把两者配对成一行。约定见 .agents/rules/task-management.md。 -->

## 完成检查清单

- [ ] 所有需求已满足
- [ ] 测试已编写并通过
- [ ] 代码已审查
- [ ] 文档已更新（如适用）
- [ ] PR 已创建
<!-- 由 complete-task 勾选 -->
