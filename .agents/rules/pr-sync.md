# PR 摘要同步

在同步 reviewer 面向的唯一 PR 摘要评论之前先读取本文件。

## 适用范围

当前调用方：
- `create-pr`：首次创建或更新 PR 摘要评论
- `commit`：在已有 PR 上按需刷新摘要评论
- `complete-manual-validation`：人工验证完成后原地更新摘要评论，并写入可被后续聚合复用的验证产物

如果后续 skill 也需要刷新 PR 摘要，先在对应 skill 的 reference 中引用本 rule，再补充该 skill 自身的触发条件和失败语义。

## 隐藏标记

统一使用以下隐藏标记：

```html
<!-- sync-pr:{task-id}:summary -->
```

同一个 PR 中，同一个 `{task-id}` 只能维护一条带该标记的摘要评论。

## 聚合输入

聚合当前任务目录中的最新产物：
- `plan.md` 或最新 `plan-r{N}.md`
- `code.md` 或最新 `code-r{N}.md`
- `review-code.md` 或最新 `review-code-r{N}.md`
- `manual-validation.md` 或最新 `manual-validation-r{N}.md`

聚合规则：
- 从 `plan*` 提取 2-4 条自包含的关键技术决策
- 用 `review-code*` 与 `code*` 构建审查历程表
- 从 `code*` 提取测试结果摘要
- 如果最新 `manual-validation*` 产物结论为通过，需人工校验段落优先渲染为 `### ✅ 人工验证已通过`，并摘要验证时间、验证范围和验证说明
- 某一类产物缺失时，按“无该阶段数据”处理并继续生成
- 需人工校验段落：只收进入 code 阶段后仍需人实际执行或判断、AI 无法自行关闭的校验点。
  - **准入边界**：校验结论依赖真实环境、权限、账号、外部系统或人工判断，且无法通过 agent 重跑测试、补充检查或继续修复自行关闭。
  - **来源**：`review-code*` 的「人工校验项」，以及 `code*` 中满足上述边界的校验点。
  - **写法**：每条保留项至少写明「校验什么 + 定位（文件/改动/范围）+ 为什么只能由人校验」。
  - **渲染优先级**：
    1. 最新 `manual-validation*` 产物结论为通过 -> 标题 `### ✅ 人工验证已通过` + 验证摘要。
    2. 没有通过产物且有保留项 -> 标题 `### ⚠️ 需人工校验` + 条目列表。
    3. 没有通过产物且无保留项 -> 标题 `### ✅ 无需人工校验`，正文一行 `本次改动无需人工确认事项。`，不带条目列表。

## 评论体模板

评论正文使用以下唯一权威模板：

```markdown
<!-- sync-pr:{task-id}:summary -->
<!-- last-commit: {git-head-sha} -->
## 审查摘要

> **{agent}** · {task-id}

**更新时间**：{当前时间}

{manual-validation-section}

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
*由 {agent} 自动生成 · 内部追踪：{task-id}*
```

> `{manual-validation-section}` 按上文「需人工校验段落」聚合规则渲染：已通过产物 → `### ✅ 人工验证已通过` 标题 + 验证摘要；有保留项 → `### ⚠️ 需人工校验` 标题 + 引用说明 + 条目列表；无保留项 → `### ✅ 无需人工校验` 标题 + 一行 `本次改动无需人工确认事项。`（不带 ⚠️、不带列表）。

## 评论查找与更新

已有评论必须通过 Issues comments API 获取，而不是单独的 PR comments API。

调用方在执行本章节前，必须先按 `.agents/rules/issue-pr-commands.md` / `.agents/rules/issue-sync.md` 完成 `upstream_repo` 检测。

处理顺序：
1. 获取 PR 上现有 comments，查找以 `<!-- sync-pr:{task-id}:summary -->` 开头的评论 ID
2. 渲染评论正文时，始终写入当前 `git rev-parse HEAD` 的结果到 `<!-- last-commit: {git-head-sha} -->`
3. 不存在时，POST 创建一条新评论作为兜底
4. 已存在且正文完全相同时，跳过写入
5. 已存在且正文有变化时，PATCH 原地更新

更新已有评论时，使用如下模式：

```bash
gh api "repos/$upstream_repo/issues/comments/{comment-id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

## Shell 安全规则

1. 先读取本地产物内容，再将实际文本内联到 `<<'EOF'` heredoc 中。
2. 禁止在 heredoc 中使用命令替换或变量展开。
3. 构造含 `<!-- -->` 的正文时禁止使用 `echo`，统一使用 `cat <<'EOF'` 或 `printf '%s\n'`。

## 错误处理

| 失败点 | 处理 |
|--------|------|
| `task.md` 无法读取 | 跳过同步，交由后续 verification gate 报错 |
| 聚合输入缺失 | 记警告并按现有数据继续生成 |
| `gh api` GET/PATCH/POST 失败 | 输出警告并继续；是否阻塞当前 skill 由调用方决定 |
| `pr_number` 指向的 PR 不存在 | 输出 `PR #{pr-number} not found` 警告并继续 |

当调用方存在 `{task-id}` / task 目录且 GET/PATCH/POST 失败时，记录 Workflow Warning：

```bash
node .agents/scripts/workflow-warnings.js add .agents/workspace/active/{task-id} \
  --step pr-sync --severity ACTION_REQUIRED --code COMMENT_SYNC_FAILED \
  --target "pr-summary" --message "{reason}" \
  --action "修复 GitHub API / 网络问题后重跑触发 PR 摘要同步的 workflow 步骤"
```

## 结果回传

统一回传以下结果之一，供调用方在 Activity Log 或用户输出中复用：
- `summary created`
- `summary updated`
- `summary skipped (no diff)`
- `summary failed: <reason>`
