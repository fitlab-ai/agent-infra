---
name: sync-pr
description: >
  将任务处理进度同步到对应的 Pull Request，包含 PR 元数据同步和单条幂等审查摘要。
  当用户要求同步进度到 PR 时触发。参数：task-id。
---

# 同步进度到 PR

将任务处理进度同步到关联的 Pull Request。参数：task-id。

## 执行流程

### 1. 验证任务存在

按优先顺序搜索任务：
- `.agent-workspace/active/{task-id}/task.md`
- `.agent-workspace/completed/{task-id}/task.md`
- `.agent-workspace/blocked/{task-id}/task.md`

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

### 2. 读取任务信息

从 task.md 中提取：
- `pr_number`（必需，如果缺失则提示用户）
- `type`
- `issue_number`（如适用）
- `current_step`
- 任务标题、描述、状态
- `created_at`、`updated_at`、`last_synced_to_pr_at`（如存在）

### 3. 读取上下文文件

检查并读取（如存在）：
- 最高轮次的 `plan.md` / `plan-r{N}.md` - 技术方案
- `implementation.md`、`implementation-r{N}.md` - 实现报告
- `review.md`、`review-r{N}.md` - 审查报告
- `refinement.md`、`refinement-r{N}.md` - 修复报告
- 最高轮次的 `analysis.md` / `analysis-r{N}.md` - 需求分析（仅作为 `in:` label 的回退输入）

### 4. 获取仓库坐标并检查 label 体系是否已初始化

先获取仓库坐标，供后续 milestone 查询和评论同步复用：

```bash
repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
owner="${repo%%/*}"
```

执行：

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

判断规则：
- 返回 `0` -> 标准 label 体系缺失。先执行 `init-labels` 技能，然后重新执行本步骤
- 返回非 `0` -> 继续后续 PR 元数据同步

### 5. 同步 type label

根据 task.md 的 `type` 字段按下表映射：

| task.md type | GitHub label |
|---|---|
| bug、bugfix | `type: bug` |
| feature | `type: feature` |
| enhancement | `type: enhancement` |
| refactor、refactoring | `type: enhancement` |
| documentation | `type: documentation` |
| dependency-upgrade | `type: dependency-upgrade` |
| task | `type: task` |
| 其他 | 跳过 |

如果映射到具体 label，执行：

```bash
gh pr edit {pr-number} --add-label "{type-label}"
```

未映射到标准 type label 时跳过，不创建新 label。

### 6. 同步 in: label

从实现报告（优先）或分析报告中提取受影响模块：
- 优先读取 `implementation.md` 与 `implementation-r{N}.md` 中 `## 修改文件` / `## 新建文件` 的文件路径
- 如果实现报告不存在，则回退到分析报告中的受影响文件列表

对每个文件路径：
1. 取第一级目录作为模块名 `{module}`
2. 去重
3. 检查仓库中是否存在对应 label：

```bash
gh label list --search "in: {module}" --limit 10 --json name --jq '.[].name'
```

4. 只有存在精确匹配的 `in: {module}` label 时才执行：

```bash
gh pr edit {pr-number} --add-label "in: {module}"
```

5. 只添加，不移除现有的 `in:` labels

### 7. 同步 Milestone

根据 PR 当前状态、任务显式配置和分支策略，为 PR 关联线里程碑。

**a) 检查 PR 是否已有 Milestone**

执行：

```bash
gh pr view {pr-number} --json milestone --jq '.milestone.title // empty'
```

如果返回非空，保留现有里程碑并记录 `Milestone: {existing} (preserved)`，跳过后续里程碑同步。

**b) 检查 task.md 是否显式指定 milestone**

如果 task.md frontmatter 中存在非空 `milestone` 字段，优先使用该值作为目标里程碑。

**c) 推断目标线里程碑**

当 task.md 未显式指定 `milestone` 时，按以下顺序推断：

1. 检测当前分支：

```bash
git branch --show-current
```

- 如果分支名匹配 `{major}.{minor}.x`，目标里程碑为同名线里程碑 `{major}.{minor}.x`

2. 如果当前分支是 `main` 或 `master`，检测现有版本分支：

```bash
git branch -a | grep -oE '[0-9]+\.[0-9]+\.x' | sort -V | tail -1
```

- 如果存在最高版本分支 `X.Y.x`，则目标里程碑为 `(X+1).0.x`
- 如果不存在版本分支，则读取最新 tag：

```bash
git tag --list 'v*' --sort=-v:refname | head -1
```

- 当最新 tag 存在且可解析为 `X.Y.Z` 时，目标里程碑为 `X.Y.x`

3. 如果以上规则都无法得出结果，回退到 `General Backlog`

**d) 查找并设置里程碑**

执行：

```bash
gh api "repos/$repo/milestones" --paginate \
  --jq '.[] | select(.title=="{target}") | .title' | head -1
```

- 如果目标里程碑不存在，则降级到查找 `General Backlog`
- 如果 `General Backlog` 也不存在，则记录 `Milestone: skipped (not found)` 并跳过关联
- 一旦找到目标标题，执行：

```bash
gh pr edit {pr-number} --milestone "{milestone-title}"
```

### 8. 同步 Development 关联

如果 task.md 包含 `issue_number`，确保 PR body 关联当前 Issue。

1. 读取 PR body：

```bash
gh pr view {pr-number} --json body --jq '.body // ""'
```

2. 检查 body 是否已经包含以下任一关键词：
- `Closes #{issue-number}`
- `Fixes #{issue-number}`
- `Resolves #{issue-number}`

3. 如果已存在任一关键词，跳过更新
4. 如果不存在，在 body 末尾追加：

```bash
gh pr edit {pr-number} --body "$(cat <<'EOF'
{existing-body}

Closes #{issue-number}
EOF
)"
```

5. 如果 task.md 不包含 `issue_number`，记录 `Development: N/A`

### 9. 生成或更新单条幂等审查摘要

复用步骤 4 已获取的仓库坐标，并拉取 PR 已有评论：

```bash
pr_comments_jsonl="$(mktemp)"

gh api "repos/$repo/issues/{pr-number}/comments" \
  --paginate \
  --jq '.[] | {id, body}' > "$pr_comments_jsonl"
```

用隐藏标识定位唯一 summary 评论：

```html
<!-- sync-pr:{task-id}:summary -->
```

从评论列表中提取已有 summary comment id：

```bash
summary_comment_id="$(
  jq -r 'select(.body | contains("<!-- sync-pr:{task-id}:summary -->")) | .id' \
    "$pr_comments_jsonl" | head -1
)"
```

摘要内容要求：
- 面向代码审查者，不重复罗列 PR diff 已经展示的文件变更
- 从 `plan.md` 的 `## 决策`、`## 技术方法`、`## 实施步骤` 中提取 2-4 条关键技术决策
- 关键技术决策的描述必须自包含，不要引用内部文档的编号或术语（如 `方案 A/B`）；审查者应能独立理解每条决策的含义
- 从 `review.md`、`review-r{N}.md`、`refinement.md`、`refinement-r{N}.md` 构建审查历程表格
- 从 `implementation.md` 或 `refinement.md` 的测试章节提取测试结果

审查历程表格建议字段：
- `轮次`
- `结论`
- `问题统计`，例如 `B:1 M:2 m:0`
- `修复状态`

如果尚无审查产物，使用一行占位记录，例如 `Round 1 | Pending | N/A | N/A`。

候选评论格式：

```markdown
<!-- sync-pr:{task-id}:summary -->
## 审查摘要

**任务**：{task-id}
**更新时间**：{当前时间}

### 关键技术决策

- {decision-1}
- {decision-2}

### 审查历程

| 轮次 | 结论 | 问题统计 | 修复状态 |
|------|------|----------|----------|
| Round 1 | Pending | N/A | N/A |

### 测试结果

- {test-summary}

---
*由 AI 自动生成 · 内部追踪：{task-id}*
```

幂等规则：
- 如果 `summary_comment_id` 为空 -> 创建新评论
- 如果 `summary_comment_id` 存在且内容发生变化 -> 更新原评论
- 如果 `summary_comment_id` 存在且内容无变化 -> 跳过

创建新评论时，执行：

```bash
gh api "repos/$repo/issues/{pr-number}/comments" -X POST -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

更新已有评论时，执行：

```bash
gh api "repos/$repo/issues/comments/{comment-id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

### 10. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

在 task.md 中添加或更新 `last_synced_to_pr_at` 字段为 `{当前时间}`。
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Sync to PR** by {agent} — PR metadata synced, summary {created|updated|skipped} on PR #{pr-number}
  ```

### 11. 告知用户

```
进度已同步到 PR #{pr-number}。

已同步内容：
- Labels：{type-label-result}, {in-label-result}
- Milestone：{milestone-result}
- Development：{development-result}
- Summary：{created|updated|skipped}

查看：https://github.com/{owner}/{repo}/pull/{pr-number}
```

## 注意事项

1. `sync-pr` 面向代码审查者，只维护一条 reviewer-facing summary 评论，不逐轮发布完整产物。
2. PR 元数据同步必须可重复执行；重复执行时仅补齐缺失信息，不制造额外噪音。
3. 由于 Pull Request 共享 Issue 评论接口，summary 评论应使用 `issues/{pr-number}/comments` API 创建。
4. 如果 `issue_number` 缺失，Development 应记录为 `N/A`，不要让整个流程失败。

## 错误处理

- 任务未找到：提示 `Task {task-id} not found`
- 缺少 PR 编号：提示 `Task has no pr_number field`
- PR 未找到：提示 `PR #{number} not found`
- PR 已关闭/已合并：提示 `PR #{number} is closed/merged, metadata sync skipped`
- gh 认证失败：提示 `Please check GitHub CLI authentication`
