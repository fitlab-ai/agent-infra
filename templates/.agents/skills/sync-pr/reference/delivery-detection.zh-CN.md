# PR 元数据保护规则

在推断 milestone 或决定是否跳过元数据同步之前先读取本文件。

先初始化 label 状态：

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

如果结果是 `0`，先执行 `init-labels`，再重试元数据同步。

Type label 示例：
- `bug`, `bugfix` -> `type: bug`
- `refactor`, `refactoring` -> `type: enhancement`

## 同步 Milestone

Milestone 优先级：
1. PR 当前已有的 milestone
2. task.md 中显式设置的 `milestone`
3. 从 Issue 继承的 milestone
4. 推断得到的 release line
5. `General Backlog`

Milestone 推断算法：
1. 如果当前分支匹配 `{major}.{minor}.x`，直接使用该 release line
2. 如果当前分支是 `main` 或 `master`，检查现有的 `{major}.{minor}.x` 分支，并目标设为 `(X+1).0.x`
3. 如果不存在 release line 分支，则检查最新的 `vX.Y.Z` tag，并回退到 `X.Y.x`
4. 如果以上都无法得出结果，则回退到 `General Backlog`

执行顺序：
1. 如果 PR 已经设置 milestone，优先保留
2. 否则优先使用 task.md 中显式设置的 `milestone`
3. 否则继承已有的 Issue milestone
4. 否则应用上面的分支 / tag 推断规则
5. 如果目标 milestone 不可用，则回退到 `General Backlog`
6. 如果连 `General Backlog` 都不可用，则记录 `Milestone: skipped (not found)`

常用命令：

```bash
gh pr view {pr-number} --json milestone
gh issue view {issue-number} --json labels,milestone
git branch --show-current
git branch -a | grep -oE '[0-9]+\.[0-9]+\.x' | sort -V | tail -1
git tag --list 'v*' --sort=-v:refname | head -1
gh pr edit {pr-number} --add-label "{type-label}"
gh pr edit {pr-number} --add-label "in: {module}"
gh pr edit {pr-number} --milestone "{milestone-title}"
```

如果 PR 已关闭或已合并，停止元数据同步，并报告：
`PR #{number} is closed/merged, metadata sync skipped`
