# Issue 同步规则

在任务技能需要更新 GitHub Issue 时先读取本文件。

## status: label 直设

如果 task.md 中存在有效的 `issue_number`（非空、非 `N/A`），且 Issue 状态为 `OPEN`，则替换所有 `status:` label 并设置目标值：

```bash
state=$(gh issue view {issue-number} --json state --jq '.state' 2>/dev/null)
if [ "$state" = "OPEN" ]; then
  gh issue view {issue-number} --json labels \
    --jq '.labels[].name | select(startswith("status:"))' 2>/dev/null \
  | while IFS= read -r label; do
      [ -z "$label" ] && continue
      gh issue edit {issue-number} --remove-label "$label" 2>/dev/null || true
    done
  gh issue edit {issue-number} --add-label "{target-status-label}" 2>/dev/null || true
fi
```

使用 `while IFS= read -r label` 按行处理，可避免 `status: in-progress` 这类含空格 label 被 shell 按空格拆开。

如果 `gh` 命令失败，跳过并继续，不中断技能执行。

## `in:` label 同步

如果技能需要补充 `in:` label，先基于本轮改动文件提取第一级目录，再仅添加仓库中已存在的精确 label：

```bash
gh label list --search "in: {module}" --limit 10 --json name --jq '.[].name'
gh issue edit {issue-number} --add-label "in: {module}" 2>/dev/null || true
```

只添加相关 label，不移除已有 `in:` label。

## 产物评论发布

隐藏标记必须保持兼容：

```html
<!-- sync-issue:{task-id}:{file-stem} -->
```

发布前先检查是否已存在同标记评论：

```bash
gh api "repos/{owner}/{repo}/issues/{issue-number}/comments" \
  --paginate --jq '.[].body' \
  | grep -qF "<!-- sync-issue:{task-id}:{file-stem} -->"
```

如果已存在则跳过。评论格式统一为：

```markdown
<!-- sync-issue:{task-id}:{file-stem} -->
## {artifact-title}

{artifact body}

---
*由 AI 自动生成 · 内部追踪：{task-id}*
```

`summary` 评论需要额外处理：
- 先查找已有 `<!-- sync-issue:{task-id}:summary -->` 评论的 ID
- 不存在则创建
- 已存在且正文有变化时，使用 `gh api "repos/{owner}/{repo}/issues/comments/{comment-id}" -X PATCH -f body=...` 原地更新

```bash
summary_comment_id=$(gh api "repos/{owner}/{repo}/issues/{issue-number}/comments" \
  --paginate --jq '.[] | select(.body | startswith("<!-- sync-issue:{task-id}:summary -->")) | .id' \
  | head -n 1)
gh api "repos/{owner}/{repo}/issues/comments/{comment-id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

## 补发规则（`/complete-task` 归档前执行）

- 扫描任务目录中的 `analysis*.md`、`plan*.md`、`implementation*.md`、`review*.md`、`refinement*.md`
- 对每个 `{file-stem}` 用隐藏标记检查是否已发布；未发布则补发，已发布则跳过
- 补发只追加缺失评论，不删除或重排已有评论
- 位置说明从 Activity Log 推导时间线中的前后邻居，并加在评论标题下方：

```markdown
> ⚠️ 本评论为补发产物，按时间线应位于「{前一个产物标题}」之后、「{后一个产物标题}」之前。
```

- 如果只有前邻居或后邻居，仅保留存在的一侧说明；如果两侧都不存在，则不添加位置说明

标题映射：
- `analysis` / `analysis-r{N}` -> `需求分析` / `需求分析（Round {N}）`
- `plan` / `plan-r{N}` -> `技术方案` / `技术方案（Round {N}）`
- `implementation` / `implementation-r{N}` -> `实现报告（Round 1）` / `实现报告（Round {N}）`
- `review` / `review-r{N}` -> `审查报告（Round 1）` / `审查报告（Round {N}）`
- `refinement` / `refinement-r{N}` -> `修复报告（Round 1）` / `修复报告（Round {N}）`
- `summary` -> `交付摘要`

## 需求复选框同步

从 task.md 的 `## 需求` 段落提取已勾选的 `- [x]` 条目；如果没有，跳过。

读取 Issue 当前正文：

```bash
gh issue view {issue-number} --json body --jq '.body'
```

按复选框文本匹配，将对应的 `- [ ] {text}` 单向替换为 `- [x] {text}`。只有正文实际变化时，才使用 `gh api` PATCH 更新完整 body。

## Shell 安全规则

1. 先用 Read 工具读取产物全文，再把实际文本内联到 heredoc 中；禁止在 `<<'EOF'` 内使用命令替换或变量展开。
2. 构造含 `<!-- -->` 的内容时禁止使用 `echo`；统一使用 `cat <<'EOF'` heredoc 或 `printf '%s\n'`。
