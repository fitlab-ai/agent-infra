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
- 无法从当前配置、分支和 PR 事实推导 -> 只请求缺失的目标分支事实；不得猜测

Feature branch 父分支推断细则：
- 在 first-parent 历史中检查最近的已标记祖先
- 如果该 feature branch 是从 release line 切出的，优先选择 `{major}.{minor}.x`，而不是 `main` / `master`
- 如果 release line 和 `main` 看起来都合理，选择历史上更近的那个祖先
- 如果无法可靠推断父分支，只请求缺失的目标分支事实；不得猜测

创建 PR 后的下一步规则：
- `create-pr` 已内联发布 reviewer 摘要，不再推荐额外的 PR 同步命令
- 如果 PR 创建后工作流已经真正结束，推荐 `complete-task {task-id}`
- 如果工作流尚未结束，只说明当前结果，不要虚构额外命令
