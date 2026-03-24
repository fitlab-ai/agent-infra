---
name: create-issue
description: "从任务文件创建 GitHub Issue"
---

# 创建 Issue

仅从 `task.md` 创建基础 GitHub Issue，并把 `issue_number` 回写到任务文件。

## 行为边界 / 关键规则

- Issue 标题和正文只能来自 `task.md`
- 不要读取 `analysis.md`、`plan.md`、`implementation.md` 或审查产物
- 持久产物只有 GitHub Issue 本身，以及 task.md 中的 `issue_number` 更新
- 执行本技能后，你**必须**立即更新 task.md

## 执行步骤

### 1. 验证前置条件

检查：
- `.agents/workspace/active/{task-id}/task.md`
- 使用 `gh auth status` 验证 GitHub CLI 认证状态

如果 `issue_number` 已存在且既不为空也不为 `N/A`，创建前必须先与用户确认。

### 2. 提取任务信息

从 task.md 提取标题、`## Description`、`## Requirements`、`type` 和 `milestone`。

### 3. 构建 Issue 内容

检测 `.github/ISSUE_TEMPLATE`，决定使用模板路径还是 fallback 路径。

> 模板识别、`textarea`、`input`、`dropdown`、`checkboxes` 字段映射，以及 fallback 正文规则见 `reference/template-matching.md`。构建正文前先读取 `reference/template-matching.md`。

> `labels:` 过滤、Issue Type fallback、`issue-types` API、`milestone` 逻辑、`--milestone` 和 `in:` label 规则见 `reference/label-and-type.md`。创建 Issue 前先读取 `reference/label-and-type.md`。

### 4. 创建 Issue

使用 `gh issue create --title "{title}" --body "{body}" ...` 创建 Issue；如果没有有效 label，就省略 `--label`。

如果已经确定了 Issue Type，则执行：
`gh api "repos/$repo/issues/{issue-number}" -X PATCH -f type="{issue-type}" --silent`

### 5. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

回写 `issue_number`，更新 `updated_at`，并追加 Create Issue 的 Activity Log。

### 6. 告知用户

展示 Issue 编号、URL、labels、Issue Type、milestone 结果，确认 `issue_number` 已回写，并完整输出所有 TUI 里的下一步 `sync-issue` 命令。

## 完成检查清单

- [ ] 已创建 GitHub Issue
- [ ] 已仅使用 `task.md` 作为内容来源
- [ ] 已在 task.md 中记录 `issue_number`
- [ ] 已更新 `updated_at` 并追加 Activity Log
- [ ] 已输出所有 TUI 格式的 `sync-issue` 下一步命令

## 停止

完成检查清单后立即停止。不要在本技能里继续做详细进度同步。

## 注意事项

- `create-issue` 只负责创建基础 Issue；详细进度由 `sync-issue` 发布
- 如果过滤后没有有效 label，允许不带 label 创建 Issue
- 如果 Issue Type 或 milestone 设置失败，继续执行并记录结果

## 错误处理

- 任务未找到：`Task {task-id} not found`
- GitHub CLI 不可用或未认证
- task.md 的描述为空
- 创建 Issue 失败
