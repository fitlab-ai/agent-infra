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
gh pr create --base "{target-branch}" --title "{title}" --assignee @me --body "$(cat <<'EOF'
{pr-body}
EOF
)"
```

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
