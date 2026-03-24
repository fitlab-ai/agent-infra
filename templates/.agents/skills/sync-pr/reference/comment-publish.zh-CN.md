# PR 摘要评论发布

在创建或更新面向 reviewer 的唯一 PR 摘要评论之前先读取本文件。

## 创建或更新唯一且幂等的审查摘要

使用如下隐藏标记：

```html
<!-- sync-pr:{task-id}:summary -->
```

已有评论必须通过 Issues comments API 获取，而不是单独的 PR comments API。

推荐摘要章节：
- `## Review Summary`
- `### Key Technical Decisions`
- `### Review History`
- `### Test Results`

摘要内容规则：
- 面向 reviewer 编写，而不是面向终端用户
- 不要简单复述原始文件 diff
- 从 `plan.md` 中提取 2-4 条自包含的技术决策
- 避免使用 `方案 A/B` 这类内部简称；每条决策都必须独立可读
- 用 `review.md`、`review-r{N}.md`、`refinement.md` 和 `refinement-r{N}.md` 构建审查历程表
- 包含来自 `implementation.md` 或修复产物中的测试结果

推荐审查历程列：
- `轮次`
- `结论`
- `问题统计`
- `修复状态`

如果摘要评论已经存在：
- 只有内容发生变化时才更新
- 否则跳过写入

如果摘要评论不存在：
- 使用隐藏标记和当前摘要正文创建一条新评论

更新已有评论时，使用：

```bash
gh api "repos/$repo/issues/comments/{comment-id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

建议摘要正文：

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

## 更新任务状态

追加：
`- {yyyy-MM-dd HH:mm:ss} — **Sync to PR** by {agent} — PR metadata synced, summary {created|updated|skipped} on PR #{pr-number}`
