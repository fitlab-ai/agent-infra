# Label、Issue Type 和 Milestone 规则

在应用 label、Issue Type、milestone 或 `in:` label 之前先读取本文件。

## 默认正文格式（Fallback）

推荐 fallback：

```markdown
## Description

{task-description}

## Requirements

- [ ] {requirement-1}
- [ ] {requirement-2}
```

将任务类型映射到 GitHub label 和 Issue Type，但只保留仓库里实际存在的 label。

Fallback label 映射：

| task.md type | GitHub label |
|---|---|
| `bug`, `bugfix` | `type: bug` |
| `feature` | `type: feature` |
| `enhancement` | `type: enhancement` |
| `docs`, `documentation` | `type: documentation` |
| `dependency-upgrade` | `type: dependency-upgrade` |
| `task`, `chore`, `refactor`, `refactoring` | `type: task` |
| 其他值 | 跳过 |

Issue Type fallback 映射：

| task.md type | GitHub Issue Type |
|---|---|
| `bug`, `bugfix` | `Bug` |
| `feature`, `enhancement` | `Feature` |
| `task`, `documentation`, `dependency-upgrade`, `chore`, `docs`, `refactor`, `refactoring` 以及其他所有值 | `Task` |

## 创建 Issue

使用：

```bash
gh issue create --title "{title}" --body "{body}" --label "{label-1}" --label "{label-2}" --milestone "{milestone}"
```

如果最终没有有效 label，就省略 `--label`。如果 `milestone` 为空，则回退到 `General Backlog`。

Issue Type 设置：

```bash
gh api "orgs/$owner/issue-types" --jq '.[].name'
gh api "repos/$repo/issues/{issue-number}" -X PATCH -f type="{issue-type}" --silent
```

`in:` label：

```bash
gh label list --search "in:" --limit 50 --json name --jq '.[].name'
gh issue edit {issue-number} --add-label "in: {module}"
```

只添加相关的 `in:` label。不要移除已有的 `in:` label，并且当 `in:` label 不可用或不相关时，不要让创建 Issue 流程失败。

当 label、Issue Type 或 milestone 不可用时，应跳过并继续，不要让 Issue 创建失败。

最终给用户的输出必须包含所有 TUI 的 `sync-issue` 命令格式：

```text
下一步 - 同步进度到 Issue：
  - Claude Code / OpenCode: /sync-issue {task-id}
  - Gemini CLI: /agent-infra:sync-issue {task-id}
  - Codex CLI: $sync-issue {task-id}
```
