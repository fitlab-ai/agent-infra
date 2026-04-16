# Issue 同步规则

在任务技能需要更新 GitHub Issue 时先读取本文件。

## Upstream 仓库检测

外部开发者在 fork 仓库中执行 `gh` 命令时，默认目标会指向 fork，而不是原始仓库。所有后续 `gh issue` 和 `gh api "repos/..."` 操作都必须先检测 upstream 仓库，并统一复用 `upstream_repo`。

```bash
upstream_repo=$(gh api "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
  --jq 'if .fork then .parent.full_name else .full_name end' 2>/dev/null)
```

- 非 fork 仓库：返回当前仓库自身的 `full_name`
- fork 仓库：返回父仓库的 `full_name`
- 后续所有 `gh issue` 命令统一使用 `-R "$upstream_repo"`
- 后续所有 `gh api "repos/..."` 命令统一使用 `"repos/$upstream_repo/..."`

## 权限检测

所有需要写权限的操作都先对 upstream 仓库做一次权限检测。检测失败时按无权限处理，确保安全降级。

```bash
repo_perms=$(gh api "repos/$upstream_repo" --jq '.permissions' 2>/dev/null || echo '{}')
has_triage=$(printf '%s' "$repo_perms" | grep -q '"triage":true' 2>/dev/null && echo true || echo false)
has_push=$(printf '%s' "$repo_perms" | grep -q '"push":true' 2>/dev/null && echo true || echo false)
```

操作与权限映射：

| 操作 | 所需权限 | 说明 |
|------|---------|------|
| 设置/移除 label | `has_triage` | triage 是最低权限 |
| 设置/移除 milestone | `has_triage` | 同上 |
| 编辑 Issue body | `has_triage` | 需求复选框同步使用 |
| 设置 Issue Type | `has_push` | 需要 write 权限 |
| 设置 assignee | 不检测 | 无权限时直接跳过 |
| 发布/更新评论 | 无需检测 | 公开仓库中认证用户可执行 |

## 降级行为定义

| 层级 | 操作类型 | 有权限 | 无权限 |
|------|---------|--------|--------|
| 静默降级 | label / milestone / Issue Type | 直接执行 `gh` 命令，同时更新 task 留言 | 跳过 `gh` 直接操作，仅更新 task 留言，由 bot 补位 |
| 直接跳过 | assignee | 直接执行 `gh` 命令 | 不做任何替代 |
| 正常执行 | 评论 | 正常执行 | 正常执行 |

关键原则：

- 无论是否有写权限，task 留言同步都必须继续执行
- 权限不足只影响直接写 Issue 元数据的步骤，不中断整个技能
- 现有 `2>/dev/null || true` 容错模式保持不变

## 外部开发者锁定机制

维护者（`has_triage=true`）不受限制。外部开发者（`has_triage=false`）在开始任务前，必须先检查 Issue 上是否已有当前任务的 `task` 留言作者。

```bash
task_comment_author=$(gh api "repos/$upstream_repo/issues/{issue-number}/comments" \
  --paginate --jq '[.[] | select(.body | test("<!-- sync-issue:{task-id}:task -->")) | .user.login] | first' \
  2>/dev/null || echo "")
current_user=$(gh api user --jq '.login' 2>/dev/null || echo "")
```

判定规则：

- 没有 `task` 留言：允许开始
- `task` 留言作者等于当前用户：允许继续
- `task` 留言作者不等于当前用户：立即停止，并提示先与维护者协调，避免多人同时接手同一任务

## status label 设置

算法说明：下面的流程与 `.github/scripts/sync-labels-to-set.sh` 保持一致（集合差集）。本章节是 AI Agent 侧的等价实现（`target_set = {"{target-status-label}"}` 的特例）。修改任一侧时，必须同步另一侧，避免 Agent 与 Bot 的行为漂移。

如果 task.md 中存在有效的 `issue_number`（非空、非 `N/A`），且 Issue 状态为 `OPEN`，则按幂等差集方式将 `status:` label 同步到目标值：

```bash
state=$(gh issue view {issue-number} -R "$upstream_repo" --json state --jq '.state' 2>/dev/null)
if [ "$state" = "OPEN" ]; then
  current_status_labels=$(gh issue view {issue-number} -R "$upstream_repo" \
    --json labels --jq '.labels[].name | select(startswith("status:"))' 2>/dev/null || true)
  printf '%s\n' "$current_status_labels" | while IFS= read -r label; do
    [ -z "$label" ] && continue
    if [ "$label" != "{target-status-label}" ] && [ "$has_triage" = "true" ]; then
      gh issue edit {issue-number} -R "$upstream_repo" --remove-label "$label" 2>/dev/null || true
    fi
  done
  if [ "$has_triage" = "true" ] && ! printf '%s\n' "$current_status_labels" | grep -qxF "{target-status-label}"; then
    gh issue edit {issue-number} -R "$upstream_repo" --add-label "{target-status-label}" 2>/dev/null || true
  fi
fi
```

使用 `while IFS= read -r label` 按行处理，可避免 `status: in-progress` 这类含空格 label 被 shell 按空格拆开。

如果 `has_triage=false`，则跳过直接设置 label，只更新 task 留言，由 bot 根据最新 task 元数据补位。

如果 `gh` 命令失败，跳过并继续，不中断技能执行。

## Assignee 同步

当技能创建或导入 Issue 时，自动将当前执行者添加为 assignee：

- `create-issue`：在 `gh issue create` 命令中使用 `--assignee @me` 参数，并附带 `-R "$upstream_repo"`
- `import-issue`：导入后执行 `gh issue edit {issue-number} -R "$upstream_repo" --add-assignee @me 2>/dev/null || true`

`@me` 由 `gh` CLI 自动解析为当前认证用户。此操作是幂等的（重复添加不会报错）。如果命令失败（如权限不足），直接跳过，不做任何替代。

## `in:` label 同步

> **触发时机**：`in:` label 同步应在代码提交后（commit 技能）执行，不在 implement-task 或 refine-task 阶段执行。create-pr 阶段仅从 Issue 复制到 PR，不重新计算。

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
   - 应有但没有：仅当 `has_triage=true` 时执行 `gh issue edit {issue-number} -R "$upstream_repo" --add-label "in: {module}" 2>/dev/null || true`
   - 有但不应有：仅当 `has_triage=true` 时执行 `gh issue edit {issue-number} -R "$upstream_repo" --remove-label "in: {module}" 2>/dev/null || true`

### 无映射时（只增不删回退）

如果 `.airc.json` 中不存在 `labels.in` 或为空对象：

1. 查询仓库已有 `in:` labels
2. 从改动文件提取第一级目录
3. 仅当 `has_triage=true` 时添加匹配的 label，不移除已有 `in:` label

如果 `has_triage=false`，则跳过直接修改 `in:` label，只保留 task 留言同步，由后续自动化补位。

## 产物评论发布

隐藏标记必须保持兼容：

```html
<!-- sync-issue:{task-id}:{file-stem} -->
```

发布前先检查是否已存在同标记评论：

```bash
gh api "repos/$upstream_repo/issues/{issue-number}/comments" \
  --paginate --jq '.[].body' \
  | grep -qF "<!-- sync-issue:{task-id}:{file-stem} -->"
```

如果已存在则跳过。

发布流程：

1. 先读取本地产物文件全文
2. 将文件全文作为 `{artifact body}` 原文内联到评论中
3. 禁止自行组织摘要、改写或截断正文

评论格式统一为：

```markdown
<!-- sync-issue:{task-id}:{file-stem} -->
## {artifact-title}

> **{agent}** · {task-id}

{artifact body}

---
*由 {agent} 自动生成 · 内部追踪：{task-id}*
```

其中 `{agent}` 使用当前执行该技能的 AI 代理名称（如 `claude`、`codex`、`gemini`）。

`summary` 评论需要额外处理：

- 先查找已有 `<!-- sync-issue:{task-id}:summary -->` 评论的 ID
- 不存在则创建
- 已存在且正文有变化时，使用 `gh api "repos/$upstream_repo/issues/comments/{comment-id}" -X PATCH -f body=...` 原地更新

```bash
summary_comment_id=$(gh api "repos/$upstream_repo/issues/{issue-number}/comments" \
  --paginate --jq '.[] | select(.body | startswith("<!-- sync-issue:{task-id}:summary -->")) | .id' \
  | head -n 1)
gh api "repos/$upstream_repo/issues/comments/{comment-id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

评论发布不受 `has_triage` / `has_push` 限制，认证用户可正常执行。

## task.md 评论同步

隐藏标记：

```html
<!-- sync-issue:{task-id}:task -->
```

`task.md` 使用幂等更新路径：

1. 读取 `task.md` 全文
2. 将 YAML frontmatter（`---` 到 `---` 之间的内容）包裹在 `<details><summary>元数据 (frontmatter)</summary>` 和 `` ```yaml `` 代码块中，其余正文保持原样作为 Markdown 渲染
3. 使用 `task` 作为 `{file-stem}`
4. 查找已有标记评论 ID
5. 不存在则创建
6. 已存在且正文有变化则 PATCH 原地更新
7. 已存在且正文相同则跳过

task.md 评论格式：

```markdown
<!-- sync-issue:{task-id}:task -->
## 任务文件

> **{agent}** · {task-id}

<details><summary>元数据 (frontmatter)</summary>

​```yaml
---
{frontmatter fields}
---
​```

</details>

{task.md body after frontmatter}

---
*由 {agent} 自动生成 · 内部追踪：{task-id}*
```

还原时，从 `<details>` 块中提取 frontmatter，与正文拼合恢复为原始 `task.md`。

评论标题映射：

- `task` -> `任务文件`

task 留言同步始终执行，不受权限降级影响。

## 补发规则（`/complete-task` 归档前执行）

- 扫描任务目录中的 `task.md`、`analysis*.md`、`plan*.md`、`implementation*.md`、`review*.md`、`refinement*.md`
- 对每个 `{file-stem}` 用隐藏标记检查是否已发布；未发布则补发，已发布则跳过
- 补发只追加缺失评论，不删除或重排已有评论
- 补发评论的 `{agent}` 按以下顺序确定：
  1. 从 Activity Log 中匹配对应产物文件名（如 `→ analysis.md`），提取 `by {agent}` 中的执行者
  2. 若未匹配到，则回退到 task.md frontmatter 的 `assigned_to`
  3. 若 `assigned_to` 也不可用，则使用当前执行补发的 agent
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

补发评论同样不受 `has_triage` / `has_push` 限制。

## 需求复选框同步

从 task.md 的 `## 需求` 段落提取已勾选的 `- [x]` 条目；如果没有，跳过。

读取 Issue 当前正文：

```bash
gh issue view {issue-number} -R "$upstream_repo" --json body --jq '.body'
```

按复选框文本匹配，将对应的 `- [ ] {text}` 单向替换为 `- [x] {text}`。只有正文实际变化且 `has_triage=true` 时，才使用 `gh api` PATCH 更新完整 body。

如果 `has_triage=false`，则跳过正文 PATCH，只更新 task 留言，由 bot 根据最新任务状态补位。

## Shell 安全规则

1. 先用 Read 工具读取产物全文，再把实际文本内联到 heredoc 中；禁止在 `<<'EOF'` 内使用命令替换或变量展开。
2. 构造含 `<!-- -->` 的内容时禁止使用 `echo`；统一使用 `cat <<'EOF'` heredoc 或 `printf '%s\n'`。
