# 评论发布规则

在创建或更新 Issue 评论之前先读取本文件。

## 拉取已有评论并构建已发布产物集合

使用如下隐藏标记：

```html
<!-- sync-issue:{task-id}:{file-stem} -->
```

产物提取规则：
- 用 `/→\s+(\S+\.md)\s*$/` 从 Activity Log 中提取产物文件名
- 去掉 `.md` 后缀得到 `{file-stem}`
- 按 Activity Log 顺序构建产物时间线
- 固定把 `summary` 追加到最后

产物时间线必须按 Activity Log 顺序构建。只包含任务目录中仍然存在的产物文件。
常见产物文件名包括 `implementation-r*.md` 和 `review-r*.md`。

已发布集合检测：

```bash
grep -qF "<!-- sync-issue:{task-id}:{file-stem} -->" "$comments_jsonl"
```

含义：
- 找到匹配 -> 该产物已经发布过
- 没有匹配 -> 该产物本轮可以创建

在开始发布评论前，先定义 `has_unpublished_artifacts`：即时间线中是否还存在任何未发布的非 `summary` 产物。该标志在本轮同步过程中保持不变。

推荐标题映射：

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

## 按时间线顺序逐个发布上下文产物

始终把 `summary` 放在最后。不要把多个轮次折叠成一条评论。

统一评论格式：

```markdown
<!-- sync-issue:{task-id}:{file-stem} -->
## {artifact-title}

{artifact original body or summary body}

---
*由 AI 自动生成 · 内部追踪：{task-id}*
```

`summary` 处理规则：
- 如果 `summary` 不存在，就创建它
- 如果 `summary` 已存在且 `has_unpublished_artifacts=true`，删除旧的 `summary`，并在最后重新创建
- 如果 `summary` 已存在、`has_unpublished_artifacts=false`，且内容发生变化，则原地 patch 该评论
- 如果 `summary` 已存在、`has_unpublished_artifacts=false`，且内容没有变化，则不做任何操作

零操作规则：
- 如果所有产物都已同步，且 `summary` 内容未变化，则不要发布任何内容，并报告 `所有产物已同步，无新内容`

更新已有 `summary` 评论时，使用：

```bash
gh api "repos/$repo/issues/comments/{summary_comment_id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

必须使用以下绝对链接格式：
- `https://github.com/{owner}/{repo}/commit/{commit-hash}`
- `https://github.com/{owner}/{repo}/pull/{pr-number}`

不要回退到固定的 `analysis -> plan -> implementation -> review -> summary` 顺序。
