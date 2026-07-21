# Issue / PR 平台命令

在读取或写入 PR，或选择 Issue intent 前先读取本文件。

## 平台上下文与能力

调用 `agent-infra-internal platform-context resolve` 取得规范 upstream、当前用户和 `comment/triage/push/admin` capabilities。调用方不得自行解释 remote、认证 stderr 或权限 JSON。`failed`/`blocked` 按调用该规则的 Skill 约定停止或降级。

Issue 资源必须使用 `platform-issue`；本文件保留的直接 `gh pr` 命令属于 09/10 PR 兼容区。

## Issue intent

```bash
agent-infra-internal platform-issue inspect {task-id}
agent-infra-internal platform-issue create {task-id} --agent {agent}
agent-infra-internal platform-issue bind {task-id} --issue {number} --agent {agent}
agent-infra-internal platform-issue sync {task-id} --agent {agent} {desired-state-flags}
```

模板检测、确定性正文、Issue identity、labels、assignees、milestone、Issue Type、pinned fields、requirements 与关闭状态全部由 intent 处理。调用方不得直接使用 `gh issue` 或 Issue GraphQL。

## Issue 评论读取

统一调用 `agent-infra-internal platform-comment list --issue {issue-number}`。该 intent 负责分页、顺序、marker identity 与结构化错误；历史任务扫描直接消费其 `comments` 数组，不再拼跨平台 pipeline。

## PR 模板与元数据辅助命令

存在仓库 PR 模板时读取：

```bash
cat .github/PULL_REQUEST_TEMPLATE.md
```

参考最近合并的 PR 风格：

```bash
gh pr list --limit 3 --state merged --json number,title,body
```

PR 元数据同步前验证标准 type labels 是否存在：

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

如果结果是 `0`，先运行 `init-labels`，再重试 PR 元数据同步。

## PR 读取与创建

读取 PR：

```bash
gh pr view {pr-number} --json number,title,body,labels,state,milestone,url,files
```

列出 PR：

```bash
gh pr list --state {state} --base {base-branch} --json number,title,url,headRefName,baseRefName
```

按 head 分支查询当前分支是否存在开放 PR（`commit` 推送收尾用）：

```bash
gh pr list --head "{branch}" --state open --json number,url --jq '.[0].url // empty'
```

创建 PR：

```bash
gh pr create --base "{target-branch}" --title "{title}" --assignee @me \
  {label-args} {milestone-arg} \
  --body "$(cat <<'EOF'
{pr-body}
EOF
)"
```

- `{label-args}` 由调用方按有效 label 列表展开为多个 `--label "{label}"`
- 仅当 `has_triage=true` 时传入 `{label-args}`；否则整体省略并继续
- 没有有效 label 时省略全部 `--label`
- `{milestone-arg}` 展开为 `--milestone "{milestone}"`
- 仅当 `has_triage=true` 时传入 `{milestone-arg}`；否则整体省略并继续
- `{milestone-arg}` 为空时整体省略

## PR 更新

更新 PR 标题、label 或 milestone：

```bash
gh pr edit {pr-number} {edit-args}
```

常见参数：
- `--title "{title}"`
- `--add-label "{label}"`
- `--remove-label "{label}"`
- `--milestone "{milestone}"`

## 错误处理

- 读取失败：按调用方规则决定停止还是跳过
- 更新失败：如果调用方标记为 best-effort，输出警告并继续
- 权限不足：按 `has_triage` / `has_push` 分支跳过直接写操作，不阻塞调用方
- `@me` 由 `gh` CLI 解析为当前认证用户
