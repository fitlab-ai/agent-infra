# Issue / PR 平台命令

在需要验证平台认证、读取 Issue / PR，或执行 Issue / PR 创建与更新前先读取本文件。

## 认证与仓库信息

先验证 GitHub CLI 可用且已认证：

```bash
gh auth status
gh repo view --json nameWithOwner
```

如果任一命令失败，按调用该规则的 skill 约定停止或降级。

## Upstream 仓库与权限检测

在后续任何 `gh issue` 或 `gh api "repos/..."` 操作之前，先按 `.agents/rules/issue-sync.md` 完成 `upstream_repo`、`has_triage` 和 `has_push` 检测。

- 后续所有 `gh issue` 命令统一使用 `-R "$upstream_repo"`
- 后续所有 repo 级 `gh api` 命令统一使用 `"repos/$upstream_repo/..."`
- `gh pr *` 命令保持作用于当前仓库，不额外加 `-R`
- `gh api "orgs/{owner}/..."` 这类 org 级命令保持不变

## Issue 模板检测

使用以下命令检测 GitHub Issue Forms：

```bash
rg --files .github/ISSUE_TEMPLATE -g '*.yml' -g '!config.yml'
```

创建 Issue 前先读取匹配的 form 文件。目录不存在或没有匹配 form 时，使用调用方定义的 fallback 正文格式。

常见候选模板：
- `bug_report.yml`：bug 工作
- `question.yml`：问题或排查工作
- `feature_request.yml`：功能工作
- `documentation.yml`：文档工作
- `other.yml`：通用 fallback

对 GitHub Issue Forms，检查匹配 form 的：
- `name`
- `type:`
- `labels:`
- `body:`

字段处理规则：
- `textarea` 和 `input`：使用 `attributes.label` 作为 markdown 标题，并从 task.md 填充值
- `markdown`：跳过模板说明文案
- `dropdown` 和 `checkboxes`：跳过
- task.md 缺少合适值时，写入 `N/A`

建议字段映射：

| 模板字段提示 | task.md 来源 |
|---|---|
| `summary`, `title` | 任务标题 |
| `description`, `problem`, `what happened`, `issue-description`, `current-content` | 任务描述 |
| `solution`, `requirements`, `steps`, `suggested-content`, `impact`, `context`, `alternatives`, `expected` | 需求列表 |
| 其他 `textarea` / `input` 字段 | 任务描述，否则 `N/A` |

## Issue 读取与创建

读取 Issue：

```bash
gh issue view {issue-number} -R "$upstream_repo" --json number,title,body,labels,state,milestone,url
```

创建 Issue：

```bash
gh issue create -R "$upstream_repo" --title "{title}" --body "{body}" --assignee @me {label-args} {milestone-arg}
```

- `{label-args}` 由调用方按有效 label 列表展开为多个 `--label`
- 仅当 `has_triage=true` 时传入 `{label-args}`；否则整体省略并继续
- 没有有效 label 时省略全部 `--label`
- 仅当 `has_triage=true` 时传入 `{milestone-arg}`；否则整体省略并继续
- `{milestone-arg}` 为空时整体省略

设置 Issue Type：

```bash
gh api "orgs/{owner}/issue-types" --jq '.[].name'
gh api "repos/$upstream_repo/issues/{issue-number}" -X PATCH -f type="{issue-type}" --silent
```

- 仅当 `has_push=true` 时执行 Issue Type 设置；否则跳过并继续

## Issue 更新

更新标题、label、assignee 或 milestone 时使用：

```bash
gh issue edit {issue-number} -R "$upstream_repo" {edit-args}
```

常见参数：
- `--title "{title}"`
- `--add-label "{label}"`（仅当 `has_triage=true`）
- `--remove-label "{label}"`（仅当 `has_triage=true`）
- `--add-assignee @me`
- `--milestone "{milestone}"`（仅当 `has_triage=true`）

Assignee 同步不做权限预判；如果命令失败，按调用方约定静默跳过。

关闭 Issue：

```bash
gh issue close {issue-number} -R "$upstream_repo" --reason "{reason}"
```

## Issue 评论读取

读取 Issue 评论或按隐藏标记查找已有评论：

```bash
gh api "repos/$upstream_repo/issues/{issue-number}/comments" --paginate
```

## PR 模板与元数据辅助命令

存在仓库 PR 模板时读取：

```bash
cat .github/PULL_REQUEST_TEMPLATE.md
```

参考最近合并的 PR 风格：

```bash
gh pr list --limit 3 --state merged --json number,title,body
```

PR 元数据同步前验证标准 type labels 是否存在：

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

如果结果是 `0`，先运行 `init-labels`，再重试 PR 元数据同步。

## PR 读取与创建

读取 PR：

```bash
gh pr view {pr-number} --json number,title,body,labels,state,milestone,url,files
```

列出 PR：

```bash
gh pr list --state {state} --base {base-branch} --json number,title,url,headRefName,baseRefName
```

创建 PR：

```bash
gh pr create --base "{target-branch}" --title "{title}" --assignee @me \
  {label-args} {milestone-arg} \
  --body "$(cat <<'EOF'
{pr-body}
EOF
)"
```

- `{label-args}` 由调用方按有效 label 列表展开为多个 `--label "{label}"`
- 仅当 `has_triage=true` 时传入 `{label-args}`；否则整体省略并继续
- 没有有效 label 时省略全部 `--label`
- `{milestone-arg}` 展开为 `--milestone "{milestone}"`
- 仅当 `has_triage=true` 时传入 `{milestone-arg}`；否则整体省略并继续
- `{milestone-arg}` 为空时整体省略

## PR 更新

更新 PR 标题、label 或 milestone：

```bash
gh pr edit {pr-number} {edit-args}
```

常见参数：
- `--title "{title}"`
- `--add-label "{label}"`
- `--remove-label "{label}"`
- `--milestone "{milestone}"`

## 错误处理

- 读取失败：按调用方规则决定停止还是跳过
- 更新失败：如果调用方标记为 best-effort，输出警告并继续
- 权限不足：按 `has_triage` / `has_push` 分支跳过直接写操作，不阻塞调用方
- `@me` 由 `gh` CLI 解析为当前认证用户
