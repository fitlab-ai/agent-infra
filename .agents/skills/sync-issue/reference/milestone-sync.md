# 里程碑同步

在选择或编辑 Issue 里程碑之前先读取本文件。

## 同步里程碑

里程碑优先级：
1. Issue 当前已有的里程碑
2. task.md 中显式设置的 `milestone` 字段
3. 从当前分支推断出的版本线里程碑
4. `General Backlog`

当 task.md 没有显式设置 `milestone` 时，按以下场景推断：
1. 用 `git branch --show-current` 检测当前分支
2. 场景 A：如果当前分支匹配 `{major}.{minor}.x`，直接使用该版本线里程碑
3. 场景 B：如果当前分支是 `main` 或 `master`，检查现有的 `{major}.{minor}.x` 分支
4. 场景 B 结果：当存在最高版本线 `X.Y.x` 时，目标使用 `(X+1).0.x`
5. 场景 C：如果分支规则无法得出版本线，则检查最新的 `vX.Y.Z` tag，并回退到 `X.Y.x`
6. 场景 C 回退：如果分支和 tag 规则都无法得出版本线，则回退到 `General Backlog`

回退与赋值逻辑：
1. 如果 Issue 已经有里程碑，优先保留
2. 否则优先使用 task.md 中显式设置的 `milestone`
3. 否则应用上面的分支 / tag 场景推断规则
4. 如果推断出的目标里程碑不存在，则降级为 `General Backlog`
5. 如果 `General Backlog` 也不存在，则记录 `Milestone: skipped (not found)`，并停止 milestone 同步
6. 一旦解析出里程碑标题，就执行赋值，并记录 `{target} (assigned)` 或 `General Backlog (fallback)`

常用命令：

```bash
gh issue view {issue-number} --json milestone
git branch --show-current
git branch -a | grep -oE '[0-9]+\.[0-9]+\.x'
git tag --list 'v*' --sort=-v:refname | head -1
gh issue edit {issue-number} --milestone "{milestone-title}"
```
