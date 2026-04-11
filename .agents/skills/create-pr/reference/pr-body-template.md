# PR 正文模板规则

在生成 PR 标题和正文之前先读取本文件。

## 读取 PR 模板

读取仓库中的 `.github/PULL_REQUEST_TEMPLATE.md`。如果不存在，则使用标准格式。

## 参考最近合并的 PR

```bash
gh pr list --limit 3 --state merged --json number,title,body
```

把最近合并的 PR 当作风格和排版参考。

## 分析当前分支变更

```bash
git status
git log <target-branch>..HEAD --oneline
git diff <target-branch>...HEAD --stat
git diff <target-branch>...HEAD
```

## 同步 PR 元数据

执行前先读取 `.agents/rules/issue-pr-commands.md`。

在同步 label 之前，先确认标准 label 体系已经存在：

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

如果结果是 `0`，先执行 `init-labels`，再重试元数据同步。

Type label 映射：

| task.md type | GitHub label |
|---|---|
| `bug`, `bugfix` | `type: bug` |
| `feature` | `type: feature` |
| `enhancement` | `type: enhancement` |
| `refactor`, `refactoring` | `type: enhancement` |
| `documentation` | `type: documentation` |
| `dependency-upgrade` | `type: dependency-upgrade` |
| `task` | `type: task` |
| 其他值 | 跳过 |

元数据同步顺序：
1. 按 `.agents/rules/issue-pr-commands.md` 的 Issue 读取命令查询关联 Issue 的 labels 和 milestone
2. 按 `.agents/rules/issue-pr-commands.md` 的 PR 更新命令添加映射后的 type label
3. 按同一规则的 PR 更新命令继承非 `type:`、非 `status:` 的 Issue labels
4. 按 `.agents/rules/issue-sync.md` 的 `in:` label 同步规则精修 PR 的 `in:` label，同时同步更新关联 Issue 的 `in:` label 保持一致
5. 按 `.agents/rules/milestone-inference.md` 的「阶段 3：`create-pr`」处理 milestone，直接复用 Issue milestone
6. 确保 PR 正文包含 `Closes #{issue-number}` 或等价的 closing keyword

Milestone 规则：
- 按 `.agents/rules/milestone-inference.md` 的「阶段 3：`create-pr`」处理
- PR 直接复用 Issue milestone，不再独立推断

## 创建 PR

- 当当前工作属于活动任务时，从 task.md 中提取 `issue_number`
- 如果存在 `issue_number`，按 `.agents/rules/issue-pr-commands.md` 的 Issue 读取命令查询对应 Issue
- 在调用 PR 创建命令前，先检查当前分支是否已经存在 PR；如果已存在，直接告知用户 PR URL 和状态并结束，不要重复同步元数据或摘要
- 使用 HEREDOC 传递 PR 正文
- 如果模板中存在 `{$IssueNumber}`，替换它
- PR 正文结尾必须带上 `Generated with AI assistance`

创建 PR 时，使用 `.agents/rules/issue-pr-commands.md` 中的 “创建 PR” 命令模板。

最终用户输出必须按顺序包含以下后续动作：

```text
下一步：
  - 工作流真正结束后完成任务：
    - Claude Code / OpenCode: /complete-task {task-id}
    - Gemini CLI: /agent-infra:complete-task {task-id}
    - Codex CLI: $complete-task {task-id}
```
