---
name: create-issue
description: "从任务文件创建 GitHub Issue"
---

# 创建 Issue

仅从 `task.md` 创建基础 GitHub Issue，并把 `issue_number` 回写到任务文件。

## 行为边界 / 关键规则

- Issue 标题和正文只能来自 `task.md`
- Issue 标题格式为 `type(scope): 描述`——type 从 task.md 的 `type` 字段映射（feature→feat, bugfix→fix, refactor→refactor, docs→docs, chore→chore），scope 从受影响模块推断（无法确定时省略），描述使用 task.md 中的任务标题原文（不要翻译或改写）
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

从 task.md 提取标题、`## Description`、`## Requirements`、`type` 和 `milestone`。构造 Issue 标题：将 task.md 的 `type` 映射为 Conventional Commits type，推断 scope，拼接为 `cc_type(scope): task_title` 或 `cc_type: task_title`（scope 不确定时省略）。

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

### 5.1 补发已有产物

如果任务目录中已存在产物文件，按以下顺序补发：

1. `task.md` → `<!-- sync-issue:{task-id}:task -->` 评论（幂等创建或更新）
2. 按文件名排序补发已存在的 `analysis*.md`、`plan*.md`、`implementation*.md`、`review*.md`、`refinement*.md`

所有补发动作都必须遵循 `.agents/rules/issue-sync.md` 的原文发布、task.md 同步和分片规则。

### 6. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate create-issue .agents/workspace/active/{task-id} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 7. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

展示 Issue 编号、URL、labels、Issue Type、milestone 结果，确认 `issue_number` 已回写，并完整输出所有 TUI 里的下一步命令：

```
下一步 - 执行需求分析：
  - Claude Code / OpenCode：/analyze-task {task-id}
  - Gemini CLI：/agent-infra:analyze-task {task-id}
  - Codex CLI：$analyze-task {task-id}
```

## 完成检查清单

- [ ] 已创建 GitHub Issue
- [ ] 已仅使用 `task.md` 作为内容来源
- [ ] 已在 task.md 中记录 `issue_number`
- [ ] 已更新 `updated_at` 并追加 Activity Log
- [ ] 已输出所有 TUI 格式的下一步命令

## 停止

完成检查清单后立即停止。不要在本技能里继续做详细进度同步。

## 注意事项

- `create-issue` 只负责创建基础 Issue；后续状态、评论和复选框由工作流技能与 GitHub Actions 维护
- 如果过滤后没有有效 label，允许不带 label 创建 Issue
- 如果 Issue Type 或 milestone 设置失败，继续执行并记录结果

## 错误处理

- 任务未找到：`Task {task-id} not found`
- GitHub CLI 不可用或未认证
- task.md 的描述为空
- 创建 Issue 失败
