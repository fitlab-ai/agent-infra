# Milestone 推断规则

在 `create-issue`、`implement-task` 或 `create-pr` 处理 milestone 之前先读取本文件。

## 通用原则

- milestone 在技能生命周期中逐步收窄：版本线 -> 具体版本 -> 复用
- 任一步骤推断失败时都必须回退，不得阻塞技能执行
- 如果 `gh` CLI 不可用、未认证，或 GitHub API 请求失败，跳过 milestone 处理并继续
- 在执行 repo 级 `gh api`、`gh issue edit` 或 Issue 查询前，调用方必须先完成 `upstream_repo` / `has_triage` 检测
- 只使用仓库中实际存在的 milestone；目标 milestone 不存在时按各阶段 fallback 处理

## 分支模式检测

使用以下命令检测仓库是否存在远程 release line 分支：

```bash
git branch -r | grep -v 'HEAD' | grep -E 'origin/[0-9]+\.[0-9]+\.x$'
```

- 有输出：多版本分支模式
- 无输出：主干模式

## 阶段 1：`create-issue`

目标：在创建 Issue 时先确定粗粒度版本线。

优先级：
1. `task.md` 显式存在 `milestone` 字段且值有效 -> 直接使用
2. 否则推断版本线：
   - 主干模式：查询 open 的 `X.Y.x` 里程碑，取最低版本线
   - 多版本分支模式：优先查询 open 的 `X.Y.x` 里程碑，取最低版本线；如果无法确定则回退到 `General Backlog`
3. 推断出的版本线不存在 -> 回退到 `General Backlog`
4. `General Backlog` 也不存在 -> 省略 `--milestone`

版本线查询建议：

```bash
gh api "repos/$upstream_repo/milestones?state=open&per_page=100" \
  --jq '.[].title'
```

只匹配 `X.Y.x` 格式的标题；按 major、minor 数值升序取最小版本线。

Milestone 直设属于 `has_triage` 权限范围；如果调用方检测到 `has_triage=false`，则省略 `--milestone` 并继续。

## 阶段 2：`implement-task`

目标：开始开发时，把 Issue milestone 从版本线收窄到具体版本。

前置条件：
- `task.md` 存在有效 `issue_number`
- 当前 Issue milestone 为版本线格式 `X.Y.x`

执行顺序：
1. 查询 Issue 当前 milestone
2. 如果 milestone 不是 `X.Y.x` 格式 -> 视为已足够具体，保持不变
3. 如果 milestone 是 `X.Y.x` -> 按分支模式收窄：
   - 主干模式：查询该版本线下 open 的具体版本 milestone（如 `0.4.4`），取最新版本
   - 多版本分支模式：
     - 当前任务分支来自 `origin/X.Y.x` release line -> 在该版本线下取最新具体版本
     - 当前任务分支来自 `main` -> 找最高版本线，再取该版本线下的最新具体版本
4. 找到目标具体版本后，执行：

```bash
if [ "$has_triage" = "true" ]; then
  gh issue edit {issue-number} -R "$upstream_repo" --milestone "{version}"
fi
```

5. 如果 `has_triage=false`、目标 milestone 不存在，或无法可靠判断 -> 保持原 milestone 不变

具体版本查询建议：

```bash
gh api "repos/$upstream_repo/milestones?state=open&per_page=100" \
  --jq '.[].title'
```

- 版本线匹配：`^X\.Y\.x$`
- 具体版本匹配：`^X\.Y\.[0-9]+$`
- “最新”按 patch 数值最大确定

分支来源判断建议：

```bash
git merge-base --is-ancestor origin/{release-line} HEAD
git merge-base --is-ancestor origin/main HEAD
```

如果两个判断都不可靠或远程引用缺失，保持原 milestone，不做错误推断。

## 阶段 3：`create-pr`

目标：PR 直接复用关联 Issue 的 milestone，不再独立推断。

执行顺序：
1. 如果存在 `issue_number`，查询 Issue milestone
2. Issue 有 milestone -> 执行：

```bash
if [ "$has_triage" = "true" ]; then
  gh pr edit {pr-number} --milestone "{milestone}"
fi
```

3. Issue 没有 milestone，或 `has_triage=false` -> 跳过，不设置 PR milestone

不要再使用 `task.md`、分支名、tag 或 `General Backlog` 为 PR 单独推断 milestone。
