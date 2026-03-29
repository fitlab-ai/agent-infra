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
1. 用 `gh issue view {issue-number} --json labels,milestone` 尽力查询 Issue 的 labels 和 milestone
2. 用 `gh pr edit {pr-number} --add-label "{type-label}"` 添加映射后的 type label
3. 用重复的 `gh pr edit ... --add-label` 继承非 `type:`、非 `status:` 的 Issue labels
4. 按 `.agents/rules/issue-sync.md` 的 `in:` label 同步规则精修 PR 的 `in:` label，同时同步更新关联 Issue 的 `in:` label 保持一致
5. 按 `PR -> task.md -> Issue -> branch/tag inference -> General Backlog` 的顺序解析 milestone
6. 确保 PR 正文包含 `Closes #{issue-number}` 或等价的 closing keyword

Milestone 推断算法：
1. 如果 PR 当前已经设置了 milestone，优先保留
2. 否则使用 task.md 中显式设置的 `milestone`
3. 否则继承 Issue milestone
4. 否则按以下分支 / tag 规则推断：
   - 当前分支匹配 `{major}.{minor}.x`，直接使用该 release line
   - 当前分支是 `main` 或 `master`，检查现有 `{major}.{minor}.x` 分支，并目标设为 `(X+1).0.x`
   - 如果不存在 release line 分支，则检查最新的 `vX.Y.Z` tag，并回退到 `X.Y.x`
   - 如果以上都无法得出结果，则回退到 `General Backlog`
5. 如果推断出的 milestone 不可用，则回退到 `General Backlog`
6. 如果连 `General Backlog` 都不可用，则记录 `Milestone: skipped (not found)`

## 创建 PR

- 当当前工作属于活动任务时，从 task.md 中提取 `issue_number`
- 如果存在 `issue_number`，用 `gh issue view {issue-number} --json number,title --jq '.number'` 尽力查询对应 Issue
- 在调用 `gh pr create` 前，先检查当前分支是否已经存在 PR；如果已存在，直接告知用户 PR URL 和状态并结束，不要重复同步元数据或摘要
- 使用 HEREDOC 传递 PR 正文
- 如果模板中存在 `{$IssueNumber}`，替换它
- PR 正文结尾必须带上 `Generated with AI assistance`

```bash
gh pr create --base <target-branch> --title "<title>" --assignee @me --body "$(cat <<'EOF'
<Complete PR description following template>

Generated with AI assistance
EOF
)"
```

最终用户输出必须按顺序包含以下后续动作：

```text
下一步：
  - 工作流真正结束后完成任务：
    - Claude Code / OpenCode: /complete-task {task-id}
    - Gemini CLI: /agent-infra:complete-task {task-id}
    - Codex CLI: $complete-task {task-id}
```
