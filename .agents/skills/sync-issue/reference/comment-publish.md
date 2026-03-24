# Comment Publication

Read this file before creating or updating Issue comments.

### 9. Fetch Existing Comments and Build the Published Artifact Set

Use hidden markers like:

```html
<!-- sync-issue:{task-id}:{file-stem} -->
```

Artifact extraction rules:
- extract artifact filenames from Activity Log with `/→\s+(\S+\.md)\s*$/`
- drop the `.md` suffix to get `{file-stem}`
- build the artifact timeline in Activity Log order
- append `summary` as the fixed final artifact

Build the artifact timeline in Activity Log order. Only include artifacts whose files still exist.
Typical artifact filenames include `implementation-r*.md` and `review-r*.md`.

Published-set detection:

```bash
grep -qF "<!-- sync-issue:{task-id}:{file-stem} -->" "$comments_jsonl"
```

Interpretation:
- match found -> the artifact is already published
- no match -> the artifact can be created now

Define `has_unpublished_artifacts` before publishing comments: whether any non-`summary` artifact in the timeline is still unpublished. Keep that flag fixed while processing this sync pass.

Recommended title mapping:

| file-stem | title |
|---|---|
| `analysis` | `需求分析` |
| `analysis-r{N}` | `需求分析（Round {N}）` |
| `plan` | `技术方案` |
| `plan-r{N}` | `技术方案（Round {N}）` |
| `implementation` | `实现报告（Round 1）` |
| `implementation-r{N}` | `实现报告（Round {N}）` |
| `refinement` | `修复报告（Round 1）` |
| `refinement-r{N}` | `修复报告（Round {N}）` |
| `review` | `审查报告（Round 1）` |
| `review-r{N}` | `审查报告（Round {N}）` |
| `summary` | `交付摘要` |

### 10. Publish Context Files One by One in Timeline Order

Keep `summary` last. Do not collapse multiple rounds into one comment.

Unified comment format:

```markdown
<!-- sync-issue:{task-id}:{file-stem} -->
## {artifact-title}

{artifact original body or summary body}

---
*由 AI 自动生成 · 内部追踪：{task-id}*
```

Summary handling rules:
- if `summary` does not exist, create it
- if `summary` exists and `has_unpublished_artifacts=true`, delete the old `summary` and recreate it at the end
- if `summary` exists, `has_unpublished_artifacts=false`, and the content changed, patch the existing comment in place
- if `summary` exists, `has_unpublished_artifacts=false`, and the content is unchanged, do nothing

Zero-operation rule:
- if all artifacts are already synced and `summary` content is unchanged, publish nothing and report `所有产物已同步，无新内容`

When updating an existing summary comment, use:

```bash
gh api "repos/$repo/issues/comments/{summary_comment_id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

Required link formats:
- `https://github.com/{owner}/{repo}/commit/{commit-hash}`
- `https://github.com/{owner}/{repo}/pull/{pr-number}`

Do not fall back to a fixed `analysis -> plan -> implementation -> review -> summary` order.
