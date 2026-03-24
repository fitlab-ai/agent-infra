# PR Summary Comment Publication

Read this file before creating or updating the single reviewer-facing PR summary comment.

### 9. Create or Update the Single Idempotent Review Summary

Use the hidden marker:

```html
<!-- sync-pr:{task-id}:summary -->
```

Fetch existing comments through the Issues comments API, not a separate PR comment API.

Recommended summary sections:
- `## Review Summary`
- `### Key Technical Decisions`
- `### Review History`
- `### Test Results`

Summary content rules:
- write for reviewers, not for end users
- do not restate the raw file diff
- extract 2-4 self-contained technical decisions from `plan.md`
- avoid internal shorthand such as `方案 A/B`; each decision must make sense on its own
- build a review-history table from `review.md`, `review-r{N}.md`, `refinement.md`, and `refinement-r{N}.md`
- include test results from `implementation.md` or refinement artifacts

Recommended review-history columns:
- `轮次`
- `结论`
- `问题统计`
- `修复状态`

If a summary comment already exists:
- update it only when the content changed
- otherwise skip the write

If no summary comment exists:
- create one with the marker and the current summary body

Update an existing comment with:

```bash
gh api "repos/$repo/issues/comments/{comment-id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

Suggested summary body:

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

### 10. Update Task Status

Append:
`- {yyyy-MM-dd HH:mm:ss} — **Sync to PR** by {agent} — PR metadata synced, summary {created|updated|skipped} on PR #{pr-number}`
