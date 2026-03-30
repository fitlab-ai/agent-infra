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

用 `while IFS= read -r label` 按行迭代，避免 `status: in-progress` 这类含空格 label 被 shell 按空格拆开。

如果 `gh` 命令失败，跳过并继续，不中断技能执行。

## `in:` label 同步

读取 `.agents/.airc.json` 的 `labels.in` 映射。

```bash
git diff {base-branch}...HEAD --name-only
```

`{base-branch}` 通常为 `main`；如果在 PR 上下文中，则使用 PR 的 base branch。

### 有映射时（精确增删）

1. 获取分支全部改动文件
2. 对每个文件按目录前缀匹配 `labels.in` 中的值，得到"应有的 `in:` labels"集合
3. 查询 Issue/PR 当前的 `in:` labels
4. 差集比较：
   - 应有但没有 → `gh issue edit {issue-number} --add-label "in: {module}" 2>/dev/null || true`
   - 有但不应有 → `gh issue edit {issue-number} --remove-label "in: {module}" 2>/dev/null || true`

### 无映射时（只增不删回退）

如果 `.airc.json` 中不存在 `labels.in` 或为空对象：
1. 查询仓库已有 `in:` labels
2. 从改动文件提取第一级目录
3. 仅添加匹配的 label，不移除已有 `in:` label

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

如果已存在则跳过。

发布流程：

1. 先读取本地产物文件全文
2. 将文件全文作为 `{artifact body}` 原文内联到评论中
3. 禁止自行组织摘要、改写或截断正文
4. 如果内容超过分片阈值，按下方“分片发布”规则处理

评论格式统一为：

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

## task.md 评论同步

隐藏标记：

```html
<!-- sync-issue:{task-id}:task -->
```

`task.md` 使用幂等更新路径：

1. 读取 `task.md` 全文
2. 将 YAML frontmatter（`---` 到 `---` 之间的内容）包裹在 `<details><summary>元数据 (frontmatter)</summary>` 和 `` ```yaml `` 代码块中，其余正文保持原样作为 Markdown 渲染
3. 如内容超过分片阈值，按”分片发布”规则以 `task` 为 `{file-stem}` 处理
4. 查找已有标记评论 ID
5. 不存在则创建
6. 已存在且正文有变化则 PATCH 原地更新
7. 已存在且正文相同则跳过

task.md 评论格式：

```markdown
<!-- sync-issue:{task-id}:task -->
## 任务文件

<details><summary>元数据 (frontmatter)</summary>

​```yaml
---
{frontmatter fields}
---
​```

</details>

{task.md body after frontmatter}

---
*由 AI 自动生成 · 内部追踪：{task-id}*
```

还原时，从 `<details>` 块中提取 frontmatter，与正文拼合恢复为原始 `task.md`。

评论标题映射：
- `task` -> `任务文件`

## 分片发布

当文件正文超过 60000 字符时（为标题、标记和页脚预留空间），必须分片发布。

分片隐藏标记：

```html
<!-- sync-issue:{task-id}:{file-stem}:{part}/{total} -->
```

分片规则：

1. 计算文件总字符数
2. 小于等于 60000 字符时，按常规单条评论发布
3. 大于 60000 字符时，以 60000 字符为上限并尽量在最近的换行符处分片；如果该范围内没有换行符，则在 60000 字符处强制切割
4. 每个分片独立发布，标题追加 `（{part}/{total}）`
5. 还原时按 `{part}` 升序拼接分片正文

`task.md` 与所有产物文件都适用这套规则。

## 补发规则（`/complete-task` 归档前执行）

- 扫描任务目录中的 `task.md`、`analysis*.md`、`plan*.md`、`implementation*.md`、`review*.md`、`refinement*.md`
- 对每个 `{file-stem}` 用隐藏标记检查是否已发布；未发布则补发，已发布则跳过
- 补发只追加缺失评论，不删除或重排已有评论
- 位置说明从 Activity Log 推导时间线中的前后邻居，并加在评论标题下方：

```markdown
> ⚠️ 本评论为补发产物，按时间线应位于「{前一个产物标题}」之后、「{后一个产物标题}」之前。
```

- 如果只有前邻居或后邻居，仅保留存在的一侧说明；如果两侧都不存在，则不添加位置说明

标题映射：
- `task` -> `任务文件`
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
