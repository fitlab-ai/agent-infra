# 交付状态探测

在判断任务是已完成、处于 PR 阶段还是仍在开发中之前先读取本文件。

## 探测交付状态

先解析仓库坐标：

```bash
repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
owner="${repo%%/*}"
repo_url="https://github.com/$repo"
```

交付状态检查：
- 从 Activity Log 中的 `**Commit** by` 提取最后一个 commit hash
- 用 `git branch -a --contains {commit-hash} 2>/dev/null` 检查受保护分支
- 用 `gh pr view {pr-number} --json state,mergedAt` 检查 PR 状态

受保护分支匹配规则：
- 输出包含 `main` 或 `master` -> 视为受保护主线分支
- 输出匹配 `{major}.{minor}.x` -> 视为受保护版本线分支
- 其他情况 -> 不在受保护分支上

场景判断矩阵：

| 条件 | 场景 |
|---|---|
| commit 已经位于受保护分支上 | 场景 A：已完成 |
| 存在 PR，且其状态为 `OPEN` 或 `MERGED` | 场景 B：PR 阶段 |
| 其他所有情况 | 场景 C：开发中 |

场景优先级：
- 场景 A：已完成
- 场景 B：PR 阶段
- 场景 C：开发中

优先级规则：`场景 A > 场景 B > 场景 C`。即使存在 PR，只要 commit 已经位于 `main`、`master` 或 `{major}.{minor}.x` 上，就应将任务报告为已完成。

绝对链接必须使用：
- `https://github.com/{owner}/{repo}/commit/{commit-hash}`
- `https://github.com/{owner}/{repo}/pull/{pr-number}`
