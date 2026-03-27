---
name: sync-issue
description: "将任务进度同步到 GitHub Issue"
---

# 同步进度到 Issue

把任务状态、摘要评论和产物发布时间线同步到关联的 GitHub Issue。

## 执行流程

### 1. 解析参数

同时接受 `task-id` 和 issue number。对于 issue number，使用下面的命令反查任务：

```bash
grep -rl "^issue_number: {issue-number}$" \
  .agents/workspace/active/ \
  .agents/workspace/blocked/ \
  .agents/workspace/completed/ \
  2>/dev/null | head -1
```

如果没有匹配任务，输出 `No task found associated with Issue #{issue-number}`。

### 2. 验证任务存在

按 active、blocked、completed 的顺序定位匹配任务目录，再继续后续步骤。

### 3. 读取任务信息

从 task.md 提取 `issue_number`、`type`、标题、状态、`current_step` 和时间戳字段。

### 4. 读取上下文文件

读取最高轮次的 `analysis.md` / `analysis-r{N}.md`、`plan.md` / `plan-r{N}.md`，以及仍然存在的实现、修复、审查产物。

### 5. 同步 Labels 和 Issue Type

> label 初始化、`status:` 替换规则、`in:` label 发现，以及 `issue-types` 映射逻辑见 `reference/label-sync.md`。编辑 Issue 元数据前先读取 `reference/label-sync.md`。

### 6. 同步 Development 关联

如果存在 `pr_number`，确保 PR 正文包含以下任一项：
- `Closes #{issue-number}`
- `Fixes #{issue-number}`
- `Resolves #{issue-number}`

### 7. 同步里程碑

> milestone 继承、版本分支推断和 `General Backlog` 回退规则见 `reference/milestone-sync.md`。编辑 Issue milestone 前先读取 `reference/milestone-sync.md`。

### 8. 同步需求复选框

从 task.md 的 `## 需求` 段落提取已勾选的 `- [x]` 项；如果没有，跳过。
读取 Issue 当前正文：`gh issue view {issue-number} --json body --jq '.body'`。
按复选框文本匹配，将 Issue body 中对应的 `- [ ] {text}` 单向替换为 `- [x] {text}`；已有 `- [x]`、未匹配项和非需求复选框保持不变。
只有在正文实际变化时，才使用 `gh api` PATCH 更新完整 body，并用 `cat <<'EOF'` heredoc 构造请求内容。

### 9. 发布上下文产物

> 已有评论探测、隐藏标记、产物时间线和 summary 评论顺序见 `reference/comment-publish.md`。发布 Issue 评论前先读取 `reference/comment-publish.md`。

> **Shell 安全规则**（发布评论前必读）：
> 1. `{comment-body}` 必须替换为**实际的内联文本**。先用 Read 工具读取文件，再将全文粘贴到 heredoc body 中。**禁止**在 `<<'EOF'` 内部使用 `$(cat ...)`、`$(< ...)`、`$(...)`、`${...}`。带引号 heredoc 会阻止所有命令替换和变量展开，它们会被当作字面文本输出。
> 2. 构造含 `<!-- -->` 的字符串时，**禁止使用 `echo`**。bash/zsh 中 `echo` 会将 `!` 转义为 `\!`，导致隐藏标识可见。所有评论内容以及步骤 8 的 Issue body 更新都统一使用 `cat <<'EOF'` heredoc 或 `printf '%s\n'` 构造。

### 10. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 task.md 中的 `last_synced_at`，并追加 Sync to Issue 的 Activity Log。

### 11. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

汇总已同步的 labels、milestone、development 关联、已发布评论，并给出 Issue URL。

如果任务有关联 PR，追加：

```
下一步 - 同步任务进度到 PR（可选）：
  - Claude Code / OpenCode：/sync-pr {task-id}
  - Gemini CLI：/agent-infra:sync-pr {task-id}
  - Codex CLI：$sync-pr {task-id}
```

如果任务已进入最终阶段，追加：

```
下一步 - 完成并归档任务（可选）：
  - Claude Code / OpenCode：/complete-task {task-id}
  - Gemini CLI：/agent-infra:complete-task {task-id}
  - Codex CLI：$complete-task {task-id}
```

## 注意事项

- 隐藏评论标记必须保持为 `<!-- sync-issue:{task-id}:{file-stem} -->`
- 产物时间线按 Activity Log 顺序构建，而不是固定的 `analysis -> plan -> implementation -> review -> summary`
- 发布评论和更新 Issue body 时遵守步骤 9 的 Shell 安全规则，不要在带引号 heredoc 中依赖命令替换，也不要用 `echo` 构造 HTML 注释标记

## 错误处理

- 任务未找到：`Task {task-id} not found`
- 缺少 `issue_number`：`Task has no issue_number field`
- GitHub CLI 认证失败：`Please check GitHub CLI authentication`
- Issue 不存在：`Issue #{number} not found`
