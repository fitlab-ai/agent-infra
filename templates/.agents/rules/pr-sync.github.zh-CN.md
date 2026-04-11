# PR 摘要同步

在同步 reviewer 面向的唯一 PR 摘要评论之前先读取本文件。

## 适用范围

当前调用方：
- `create-pr`：首次创建或更新 PR 摘要评论
- `commit`：在已有 PR 上按需刷新摘要评论

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
- `implementation.md` 或最新 `implementation-r{N}.md`
- `review.md` 或最新 `review-r{N}.md`
- `refinement.md` 或最新 `refinement-r{N}.md`

聚合规则：
- 从 `plan*` 提取 2-4 条自包含的关键技术决策
- 用 `review*` 与 `refinement*` 构建审查历程表
- 从 `implementation*` 或 `refinement*` 提取测试结果摘要
- 某一类产物缺失时，按“无该阶段数据”处理并继续生成

## 评论体模板

评论正文使用以下唯一权威模板：

```markdown
<!-- sync-pr:{task-id}:summary -->
<!-- last-commit: {git-head-sha} -->
## 审查摘要

> **{agent}** · {task-id}

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
*由 {agent} 自动生成 · 内部追踪：{task-id}*
```

## 评论查找与更新

已有评论必须通过 Issues comments API 获取，而不是单独的 PR comments API。

处理顺序：
1. 获取 PR 上现有 comments，查找以 `<!-- sync-pr:{task-id}:summary -->` 开头的评论 ID
2. 渲染评论正文时，始终写入当前 `git rev-parse HEAD` 的结果到 `<!-- last-commit: {git-head-sha} -->`
3. 不存在时，POST 创建一条新评论作为兜底
4. 已存在且正文完全相同时，跳过写入
5. 已存在且正文有变化时，PATCH 原地更新

更新已有评论时，使用如下模式：

```bash
gh api "repos/{owner}/{repo}/issues/comments/{comment-id}" -X PATCH -f body="$(cat <<'EOF'
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

## 结果回传

统一回传以下结果之一，供调用方在 Activity Log 或用户输出中复用：
- `summary created`
- `summary updated`
- `summary skipped (no diff)`
- `summary failed: <reason>`
