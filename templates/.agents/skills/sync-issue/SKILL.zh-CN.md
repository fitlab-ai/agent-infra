---
name: sync-issue
description: >
  将任务处理进度同步到对应的 GitHub Issue 评论。
  当用户要求同步进度到 Issue 时触发。参数：task-id 或 issue-number。
---

# 同步进度到 Issue

将任务处理进度同步到关联的 GitHub Issue。参数：task-id 或 issue-number。

## 执行流程

### 1. 解析参数

识别用户提供的参数：
- 纯数字（如 `123`）或 `#` + 数字（如 `#123`）-> 视为 issue number
- `TASK-` 开头 -> 视为 task-id（现有格式）

如果参数是 issue number，使用 Bash 搜索关联任务（注意：`.agent-workspace` 是隐藏目录，Grep/Glob 工具会跳过，必须使用 Bash）：

```bash
grep -rl "^issue_number: {issue-number}$" \
  .agent-workspace/active/ \
  .agent-workspace/blocked/ \
  .agent-workspace/completed/ \
  2>/dev/null | head -1
```

- 如果返回文件路径（如 `.agent-workspace/completed/TASK-xxx/task.md`），从路径中提取 `{task-id}` 和任务目录，继续执行步骤 2
- 如果无返回，提示 `No task found associated with Issue #{issue-number}`

如果参数是 task-id，继续执行步骤 2 的现有逻辑。

### 2. 验证任务存在

对于 `task-id` 路径，按优先顺序搜索任务：
- `.agent-workspace/active/{task-id}/task.md`
- `.agent-workspace/blocked/{task-id}/task.md`
- `.agent-workspace/completed/{task-id}/task.md`

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果步骤 1 已通过 issue number 找到匹配任务，则直接使用该任务目录继续后续步骤，无需再次扫描。

### 3. 读取任务信息

从 task.md 中提取：
- `issue_number`（必需 —— 如果缺失，提示用户）
- `type`
- 任务标题、描述、状态
- `current_step`、`created_at`、`updated_at`、`last_synced_at`（如存在）

### 4. 读取上下文文件

检查并读取（如存在）：
- `analysis.md` - 需求分析
- `plan.md` - 技术方案
- `implementation.md`、`implementation-r*.md` - 实现报告
- `review.md`、`review-r*.md` - 审查报告

### 5. 探测交付状态

依次执行以下探测；任一步失败时，降级到“模式 C：开发中”，不要编造无法确认的信息。

在开始探测前，先获取仓库坐标和绝对 URL 前缀：

```bash
repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
owner="${repo%%/*}"
repo_url="https://github.com/$repo"
```

**a) 提取 commit hash**

从 task.md 的 `## Activity Log` 中匹配最后一条 `**Commit** by` 记录，活动日志格式固定为：

```text
**Commit** by {agent} — {hash} {subject}
```

提取第一个词作为 commit hash；如果找不到，标记为“无 commit”。

**b) 检测 commit 是否在受保护分支上**

如果存在 commit hash，执行：

```bash
git branch -a --contains {commit-hash} 2>/dev/null
```

判断规则：
- 输出包含 `main` 或 `master` -> 已合入主分支，记录分支名
- 输出匹配 `{major}.{minor}.x` 模式的分支名 -> 已合入版本分支，记录分支名
- 都不匹配 -> 未合入受保护分支

**c) 检测关联 PR**

检查 task.md 的 `pr_number` 字段；如果存在，执行：

```bash
gh pr view {pr-number} --json state,mergedAt
```

根据返回结果识别 PR 是 `OPEN`、`MERGED` 还是其他状态。

**d) 检测 Issue 状态**

执行：

```bash
gh issue view {issue-number} --json state
```

记录 Issue 当前是 `OPEN` 还是 `CLOSED`。

**e) 综合判定交付模式**

按以下优先级确定摘要模式：

| 条件 | 模式 |
|------|------|
| commit 已在受保护分支上 | 模式 A：已完成 |
| 有 PR，且状态为 `OPEN` 或 `MERGED` | 模式 B：PR 阶段 |
| 其他情况 | 模式 C：开发中 |

优先级必须为 `模式 A > 模式 B > 模式 C`。即使存在 PR，只要 commit 已在受保护分支上，也按“已完成”处理。

后续所有 commit / PR 链接必须使用绝对 URL：
- `https://github.com/{owner}/{repo}/commit/{commit-hash}`
- `https://github.com/{owner}/{repo}/pull/{pr-number}`

不要再使用 `../../commit/...` 或 `../../pull/...` 这类相对路径。

### 6. 同步 Labels 和 Issue Type

基于步骤 5 的探测结果同步 Issue labels。

**a) 检查 label 体系是否已初始化**

执行：

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

判断规则：
- 返回 `0` -> 说明标准 label 体系缺失。先执行 `init-labels` 技能（幂等），然后重新执行本步骤
- 返回非 `0` -> 继续后续 label 同步

**b) 同步 type label**

根据 task.md 的 `type` 字段按下表映射：

| task.md type | GitHub label |
|---|---|
| bug、bugfix | `type: bug` |
| feature | `type: feature` |
| enhancement | `type: enhancement` |
| documentation | `type: documentation` |
| dependency-upgrade | `type: dependency-upgrade` |
| task | `type: task` |
| 其他（含 refactoring 等） | 跳过 |

如果映射到具体 label，执行：

```bash
gh issue edit {issue-number} --add-label "{type-label}"
```

未映射到标准 type label 时跳过，不创建新 label。

**c) 同步 status label**

先读取 Issue 上已有的 `status:` labels：

```bash
gh issue view {issue-number} --json labels --jq '.labels[].name | select(startswith("status:"))'
```

对每个已有的 `status:` label 执行移除：

```bash
gh issue edit {issue-number} --remove-label "{status-label}"
```

然后按以下优先级决定是否添加新的 `status:` label：

| 条件 | 动作 |
|---|---|
| 任务位于 `blocked/` 目录 | 添加 `status: blocked` |
| 模式 A：已完成 | 不添加新的 status label |
| 模式 B：PR 已 MERGED | 不添加新的 status label |
| 模式 B：PR OPEN | 添加 `status: in-progress` |
| 模式 C + `current_step` ∈ {`requirement-analysis`, `technical-design`} | 添加 `status: pending-design-work` |
| 模式 C + `current_step` ∈ {`implementation`, `code-review`, `refinement`} | 添加 `status: in-progress` |

如果需要添加新 label，执行：

```bash
gh issue edit {issue-number} --add-label "{status-label}"
```

**d) 同步 in: label**

从实现报告（优先）或 `analysis.md` 中提取受影响文件路径：
- 优先读取 `implementation.md` 与 `implementation-r*.md` 中 `## 修改文件` / `## 新建文件` 的文件列表
- 如果实现报告不存在，则回退到分析报告中的受影响文件列表

对每个文件路径：
1. 取第一级目录作为模块名
2. 去重
3. 检查仓库中是否存在对应 label：

```bash
gh label list --search "in: {module}" --limit 10 --json name --jq '.[].name'
```

4. 只有存在精确匹配的 `in: {module}` label 时才执行：

```bash
gh issue edit {issue-number} --add-label "in: {module}"
```

5. **只添加，不移除**现有的 `in:` labels

**e) 同步 Issue Type 字段**

根据 task.md 的 `type` 字段映射 GitHub 原生 Issue Type：

| task.md type | GitHub Issue Type |
|---|---|
| `bug`、`bugfix` | `Bug` |
| `feature`、`enhancement` | `Feature` |
| `task`、`documentation`、`dependency-upgrade`、`chore`、`docs`、`refactor`、`refactoring` 及其他值 | `Task` |

先查询组织可用的 Issue Types：

```bash
gh api "orgs/$owner/issue-types" --jq '.[].name'
```

然后仅在目标类型存在时执行：

```bash
gh api "repos/$repo/issues/{issue-number}" -X PATCH -f type="{name}"
```

容错要求：
- 如果 API 返回 `404`、仓库 owner 不是组织，或仓库未启用 Issue Types，记录 `Issue Type: skipped (not enabled)` 并继续，不要让整个同步失败
- 如果目标类型不存在，记录 `Issue Type: skipped (type not available)`
- 不要尝试创建新的 Issue Type；只使用组织中已存在的类型名称

### 7. 同步 Development

如果 task.md 包含 `pr_number`，确保 PR body 关联当前 Issue。

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

5. 如果 task.md 不包含 `pr_number`，记录为 `Development: N/A`

### 8. 同步 Milestone

根据 Issue 当前状态、任务显式配置和分支策略，为 Issue 关联线里程碑。

**a) 检查 Issue 是否已有 Milestone**

执行：

```bash
gh issue view {issue-number} --json milestone --jq '.milestone.title // empty'
```

如果返回非空，保留现有里程碑并记录 `Milestone: {existing} (preserved)`，跳过后续里程碑同步步骤。

**b) 检查 task.md 是否显式指定 milestone**

如果 task.md frontmatter 中存在非空 `milestone` 字段，优先使用该值作为目标里程碑。
此字段应填写线里程碑标题或 `General Backlog`，不要自动指定具体版本里程碑。

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

**d) 查找目标里程碑编号**

执行：

```bash
gh api "repos/$repo/milestones" --paginate \
  --jq '.[] | select(.title=="{target}") | .number'
```

- 如果目标里程碑不存在，则降级到查找 `General Backlog`
- 如果 `General Backlog` 也不存在，则记录 `Milestone: skipped (not found)` 并跳过关联

**e) 关联 Issue 到里程碑**

一旦找到目标里程碑编号，执行：

```bash
gh api "repos/$repo/issues/{issue-number}" -X PATCH -F milestone={milestone-number}
```

记录：
- `Milestone: {target} (assigned)` 或
- `Milestone: General Backlog (fallback)`

### 9. 拉取已有评论并构建已发布文件集合

一次性拉取 Issue 的全部评论，并基于隐藏标识构建“已发布文件 stem 集合”，同时在本地构建待发布的产物时间线。

先拉取评论（保留 comment id 与 body）：

```bash
comments_jsonl="$(mktemp)"

gh api "repos/$repo/issues/{issue-number}/comments" \
  --paginate \
  --jq '.[] | {id, body}' > "$comments_jsonl"
```

扫描任务目录中以下产物文件（存在才纳入待发布集合）：
- `analysis.md`
- `plan.md`
- `implementation.md`
- `implementation-r*.md`
- `review.md`
- `review-r*.md`

每条同步评论的第一行必须插入隐藏标识：

```html
<!-- sync-issue:{task-id}:{file-stem} -->
```

其中 `{file-stem}` 为去掉 `.md` 后缀后的文件名，例如 `analysis`、`plan`、`implementation`、`implementation-r2`、`review-r3`；`summary` 仍使用字面量 `summary`。

待发布时间线的排序规则必须是：
1. `analysis` 和 `plan` 无轮次概念，固定排在最前，且 `analysis` 必须先于 `plan`
2. 其余产物按轮次排序：Round 1（无后缀）→ Round 2（`-r2`）→ Round 3（`-r3`）→ …
3. 同轮次内 `implementation` 必须排在 `review` 之前
4. `summary` 始终排在最末

例如，排序结果应类似：
`analysis → plan → implementation → review → implementation-r2 → review-r2 → review-r3 → summary`

对每个 `{file-stem}`，用本地检索判断是否已发布：

```bash
grep -qF "<!-- sync-issue:{task-id}:{file-stem} -->" "$comments_jsonl"
```

- 匹配到：该产物已发布，后续默认跳过
- 未匹配：该产物尚未发布，可以创建新评论

对 `summary` 产物，额外提取评论 id 以便后续更新：

```bash
summary_comment_id="$(
  jq -r 'select(.body | contains("<!-- sync-issue:{task-id}:summary -->")) | .id' \
    "$comments_jsonl" | head -1
)"
```

幂等要求：
- 第一次执行时，只发布当前已存在产物对应的文件评论
- 第二次执行时，必须跳过已发布文件，只补发新增产物（例如 `implementation-r2`、`review-r2`）
- 如果所有产物文件评论都已发布，且 `summary` 内容没有变化，则本次不发布任何新评论
- 如果 `summary` 已发布但交付状态发生变化，只更新原评论，不新增第二条 summary 评论

### 10. 按时间线逐条发布上下文文件

按步骤 9 生成的已排序产物列表逐条处理，不要再使用固定 5 步骤，也不要把同类型多轮次产物合并到一条评论。

**a) 为每个产物准备评论内容**

- `analysis`：发布 `analysis.md` 原文
- `plan`：发布 `plan.md` 原文
- `implementation`、`implementation-r{N}`：每个文件各自发布一条评论，正文直接使用对应实现报告原文
- `review`、`review-r{N}`：每个文件各自发布一条评论，正文直接使用对应审查报告原文
- `summary`：生成精简交付摘要，只包含当前交付状态与 GitHub 上可访问的绝对链接

除 `summary` 外，其余产物都应发布原文，不要再次压缩成摘要。

每条评论统一格式：

```markdown
<!-- sync-issue:{task-id}:{file-stem} -->
## {产物标题}

{原文内容或 summary 内容}

---
*由 AI 自动生成 · 内部追踪：{task-id}*
```

推荐标题映射：
- `analysis` -> `需求分析`
- `plan` -> `技术方案`
- `implementation` -> `实现报告（Round 1）`
- `implementation-r2` -> `实现报告（Round 2）`
- `implementation-r{N}` -> `实现报告（Round {N}）`
- `review` -> `审查报告（Round 1）`
- `review-r2` -> `审查报告（Round 2）`
- `review-r{N}` -> `审查报告（Round {N}）`
- `summary` -> `交付摘要`

`summary` 评论建议格式：

```markdown
<!-- sync-issue:{task-id}:summary -->
## 交付摘要

**更新时间**：{当前时间}
**状态**：{模式化状态描述}

| 类型 | 内容 |
|---|---|
| 分支 | `{branch 或 N/A}` |
| Commit | [`{commit-short}`](https://github.com/{owner}/{repo}/commit/{commit-hash}) 或 `N/A` |
| PR | [#{pr-number}](https://github.com/{owner}/{repo}/pull/{pr-number}) 或 `N/A` |
| Issue | `{issue-state}` |

---
*由 AI 自动生成 · 内部追踪：{task-id}*
```

模式化状态描述要求：
- 模式 A：`✅ 已完成，代码已合入 {branch}`
- 模式 B：`PR 阶段，当前为 #{pr-number}（OPEN 或 MERGED）`
- 模式 C：`开发中，当前步骤为 {current_step}`

**b) 跳过已发布或缺失的产物**

- 对于 `analysis.md`、`plan.md`、`implementation*.md`、`review*.md`：如果对应文件不存在，直接跳过，不报错
- 对于任意产物：如果标识已存在，默认跳过
- 对于 `summary`：即使标识已存在，也要重新生成候选内容，用于比较是否需要更新

**c) 发布新评论**

当产物尚未发布时，执行：

```bash
gh issue comment {issue-number} --body "$(cat <<'EOF'
{comment-body}
EOF
)"
```

**d) 仅更新已有 summary 评论**

如果 `summary` 标识已存在，且新生成内容与已有内容不同，则编辑原评论：

```bash
gh api "repos/$repo/issues/comments/{comment-id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

如果内容相同，则不做任何操作。

**e) 零操作场景**

如果所有产物都已同步，且 `summary` 无需更新：
- 不发布任何新评论
- 在最终告知用户时明确说明：`所有产物已同步，无新内容`

### 11. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

在 task.md 中添加或更新 `last_synced_at` 字段为 `{当前时间}`。
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Sync to Issue** by {agent} — Progress synced to Issue #{issue-number}
  ```

### 12. 告知用户

```
进度已同步到 Issue #{issue-number}。

同步结果：
- 新发布评论：{数量}
- 更新评论：{数量}
- 已跳过步骤：{步骤列表或 `无`}
- 当前状态：{状态}
- Labels：type={type-label 或 skipped}，status={status-label 或 cleared}，in:={新增数量}
- Issue Type：{Bug / Feature / Task / skipped}
- Milestone：{preserved / assigned / fallback / skipped}
- Development：{已追加 Closes 关联 / 已存在关联 / 无 PR，跳过}

查看：https://github.com/{owner}/{repo}/issues/{issue-number}

如果本次没有发布或更新任何评论，请明确说明：所有步骤已同步，无新内容。
```

## 注意事项

1. **需要 Issue 编号**：任务的 task.md 中必须有 `issue_number`。如果缺失，提示用户。
2. **受众**：`sync-issue` 技能面向利益相关者；`sync-pr` 技能面向代码审查者。关注点不同。
3. **同步时机**：在完成重要阶段（分析、设计、实现、审查）或被阻塞时同步。
4. **避免刷屏**：不要同步过于频繁。虽然本技能使用隐藏标识保证幂等，但仍应避免无意义重复同步。

## 错误处理

- 任务未找到：提示 "Task {task-id} not found"
- 缺少 Issue 编号：提示 "Task has no issue_number field"
- Issue 未找到：提示 "Issue #{number} not found"
- gh 认证失败：提示 "Please check GitHub CLI authentication"
