# 分支策略

在推断 base branch 之前先读取本文件。

## 确定目标分支

- 如果用户显式提供了参数，例如 `main`、`develop` 或 `3.6.x`，直接使用它。
- 如果没有提供参数，检查：

```bash
git branch --show-current
git log --oneline --decorate --first-parent -20
```

判断规则：
- 当前分支是 `main` 或 `trunk` -> 使用该分支
- 当前分支是 feature branch -> 从 log decoration 推断最近的父分支
- 无法可靠判断 -> 直接询问用户

Feature branch 父分支推断细则：
- 在 first-parent 历史中检查最近的已标记祖先
- 如果该 feature branch 是从 release line 切出的，优先选择 `{major}.{minor}.x`，而不是 `main` / `master`
- 如果 release line 和 `main` 看起来都合理，选择历史上更近的那个祖先
- 如果无法可靠推断父分支，不要猜测，直接停止并询问用户

创建 PR 后的下一步规则：
- 如果存在 `issue_number`，且面向 reviewer 的上下文还未发布，优先推荐 `sync-pr #{pr_number}`
- 如果 PR 创建后工作流已经真正结束，再把 `complete-task {task-id}` 作为第二步推荐
- 当 PR 上下文仍需同步时，绝对不要把 `complete-task` 作为唯一下一步
