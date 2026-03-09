---
id: task-XXX
type: feature          # feature | bugfix | refactor | docs | review
workflow: feature-development  # feature-development | bug-fix | code-review | refactoring
status: open           # open | in-progress | review | blocked | completed
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
current_step: analysis # analysis | design | implementation | review | fix | commit
assigned_to: ""        # claude | codex | gemini | cursor | human
---

# 任务：[标题]

## 描述

[清晰简洁地描述任务。]

## 上下文

- **关联 Issue**：#XXX
- **关联 PR**：#XXX
- **分支**：`feature/xxx`

## 需求

- [ ] 需求 1
- [ ] 需求 2
- [ ] 需求 3

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

[审查阶段的反馈。发现的问题、建议。]

- [ ] 问题 1
- [ ] 问题 2

## 完成检查清单

- [ ] 所有需求已满足
- [ ] 测试已编写并通过
- [ ] 代码已审查
- [ ] 文档已更新（如适用）
- [ ] PR 已创建
