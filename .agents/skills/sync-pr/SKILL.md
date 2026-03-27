---
name: sync-pr
description: "将任务进度同步到 Pull Request"
---

# 同步进度到 PR

同步 PR 元数据，并维护一条面向 reviewer 的摘要评论。

## 执行流程

### 1. 解析参数

同时接受 `task-id` 和 PR number。对于 PR number，使用下面的命令反查任务：

```bash
grep -rl "^pr_number: {pr-number}$" \
  .agents/workspace/active/ \
  .agents/workspace/blocked/ \
  .agents/workspace/completed/ \
  2>/dev/null | head -1
```

如果没有匹配任务，输出 `No task found associated with PR #{pr-number}`。

### 2. 验证任务存在

按 active、blocked、completed 的顺序定位匹配任务目录，再继续后续步骤。

### 3. 读取任务信息

从 task.md 提取 `pr_number`、`issue_number`、任务标题、type 和最新时间戳。

### 4. 读取上下文文件

读取最新的方案、实现、审查和修复产物，用于生成 PR 元数据和 reviewer 摘要。

### 5. 解析仓库坐标并检查 label 就绪状态

先解析 `repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"`，再确认 `type:` labels 是否已经初始化。

### 6. 同步元数据

把映射后的 type label、相关 `in:` labels 和 milestone 同步到 PR 上。

> PR 状态保护、milestone 推断，以及 PR 已关闭/已合并时的跳过规则见 `reference/delivery-detection.md`。编辑 PR 元数据前先读取 `reference/delivery-detection.md`。

### 7. 同步 Development 关联

如果存在 `issue_number`，确保 PR 正文包含 `Closes #{issue-number}` 或等价的关闭关键字。

### 8. 发布 reviewer 摘要

> 隐藏标记、幂等 summary 评论更新、review history 格式，以及评论创建/更新规则见 `reference/comment-publish.md`。发布摘要前先读取 `reference/comment-publish.md`。

> **Shell 安全规则**（发布评论前必读）：
> 1. `{comment-body}` 必须替换为**实际的内联文本**。先用 Read 工具读取文件，再将全文粘贴到 heredoc body 中。**禁止**在 `<<'EOF'` 内部使用 `$(cat ...)`、`$(< ...)`、`$(...)`、`${...}`。带引号 heredoc 会阻止所有命令替换和变量展开，它们会被当作字面文本输出。
> 2. 构造含 `<!-- -->` 的字符串时，**禁止使用 `echo`**。bash/zsh 中 `echo` 会将 `!` 转义为 `\!`，导致隐藏标识可见。所有评论内容统一使用 `cat <<'EOF'` heredoc 或 `printf '%s\n'` 构造。

### 9. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 `last_synced_to_pr_at`，并追加 Sync to PR 的 Activity Log。

### 10. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

汇总已同步的 labels、milestone、development 状态、summary 结果以及 PR URL。

如果有关联 Issue，追加：

```
下一步 - 同步任务进度到 Issue（可选）：
  - Claude Code / OpenCode：/sync-issue #{issue_number}
  - Gemini CLI：/agent-infra:sync-issue #{issue_number}
  - Codex CLI：$sync-issue #{issue_number}
```

追加可选归档提示：

```
下一步 - 完成并归档任务（可选）：
  - Claude Code / OpenCode：/complete-task {task-id}
  - Gemini CLI：/agent-infra:complete-task {task-id}
  - Codex CLI：$complete-task {task-id}
```

## 注意事项

- 隐藏 summary 标记必须保持 `<!-- sync-pr:{task-id}:summary -->`
- 面向 reviewer 只保留一条摘要评论
- 如果 PR 已关闭或已合并，必须报告 `PR #{number} is closed/merged, metadata sync skipped`
- 发布摘要时遵守步骤 8 的 Shell 安全规则，不要在带引号 heredoc 中依赖命令替换，也不要用 `echo` 构造 HTML 注释标记

## 错误处理

- 未找到关联任务：`No task found associated with PR #{pr-number}`
- 任务未找到：`Task {task-id} not found`
- 缺少 PR 编号：`Task has no pr_number field`
- PR 不存在：`PR #{number} not found`
- GitHub CLI 认证失败：`Please check GitHub CLI authentication`
