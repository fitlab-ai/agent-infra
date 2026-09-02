# Issue 同步规则

> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」。

## Marker 注册表

以下 key 及格式是 Issue 评论身份的兼容契约；调用方只传 key/资源，不自行拼 marker。

| Key | Marker |
|---|---|
| `task` | `<!-- sync-issue:{task-id}:task -->` |
| `artifact` | `<!-- sync-issue:{task-id}:{artifact-stem} -->` |
| `artifactChunk` | `<!-- sync-issue:{task-id}:{artifact-stem}:{part}/{total} -->` |
| `summary` | `<!-- sync-issue:{task-id}:summary -->` |
| `cancel` | `<!-- sync-issue:{task-id}:cancel -->` |

`prSummary` 属于 `.agents/rules/pr-sync.md`，本规则不实现 PR 聚合。

`pr-review` 原文只通过 `artifact` / `artifactChunk` marker 同步为 Issue artifact 评论，不作为 `restore-task` 恢复来源；恢复仍只接受 Issue 编号并只读注册的 Issue marker，不新增 PR 来源。

## 平台 intent

平台 upstream、认证、capability、分页、marker 查找、幂等 create/update、分片、重试与错误分类由 typed platform core 统一处理：

```bash
agent-infra-internal platform-context resolve [--cwd <path>]
agent-infra-internal platform-comment list --issue <N> [--cwd <path>]
agent-infra-internal platform-comment owner <task-ref>
agent-infra-internal platform-comment sync <task-ref> \
  --kind task|artifact|summary|cancel --agent {standard-agent-token} \
  [--artifact <canonical.md>] [--body-file <path|->] [--backfill]
```

- `applied|no-op|degraded` → exit 0；`failed` → exit 1；`blocked` → exit 2。
- task 评论保持 `<details>` frontmatter 可逆格式；artifact 原文内联并在超过 profile 上限时使用 `artifactChunk`。
- 相同 intent 重放必须收敛为 `no-op`；重复 marker 返回 `COMMENT_MARKER_CONFLICT` 且不写入。
- 外部贡献者锁定统一使用 `platform-comment owner`；不同作者且无 triage 时返回 `COMMENT_OWNER_CONFLICT`。

## 降级与告警

平台结果不直接写 task.md。调用方在有关联任务时把关键失败映射为 workflow warning：

- capability 不足：`IMPORTANT / PERMISSION_DEGRADED`
- 评论同步永久失败：`ACTION_REQUIRED / COMMENT_SYNC_FAILED`
- 网络重试耗尽：`ACTION_REQUIRED / NETWORK_RETRY_EXHAUSTED`

使用 `agent-infra-internal task-warning {task-id} add ...` 登记；不得手写 warning 表。

```bash
agent-infra-internal task-warning {task-id} add \
  --step issue-sync --severity {severity} --code {code} \
  --target {target} --message {message} --action {action}
```

## Issue 元数据 intent

所有 Issue 元数据写入统一使用：

```bash
agent-infra-internal platform-issue inspect {task-id}
agent-infra-internal platform-issue create {task-id} --agent {standard-agent-token}
agent-infra-internal platform-issue bind {task-id} --issue {number} --agent {standard-agent-token}
agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} {desired-state-flags}
```

`sync` 支持 status/in labels、assignee、milestone、Issue Type、pinned fields、需求复选框与 Issue state。省略 flag 表示 preserve，`none` 表示显式清空。适配层统一处理集合差集、动态 schema、权限降级、dry-run、重试、错误分类与幂等重放；SKILL 不得拼装平台 CLI、GraphQL 或权限分支。

- `planned|applied|no-op|degraded` → exit 0
- `failed` → exit 1
- `blocked` → exit 2

status labels 始终至多一个；关闭后不保留 status label。`in:` labels 只从项目允许映射与仓库实际 labels 交集产生。需求复选框以 task.md 原文为身份，歧义时 fail closed。

PR event 的 `in:` 同步使用 `agent-infra-internal platform-pr sync-in-labels --pr <N> [--cwd <path>]`。PR files 是事件证据；唯一 closing Issue 按 Issue→PR 顺序写入并复读，零或多个 closing Issue 只写 PR 并返回 `degraded`。写入后副作用不明或复读未收敛必须返回 `blocked` 与 `IN_LABEL_SYNC_PARTIAL`，不得吞为 warning 或新增 `partial` 状态。

## 补发

complete-task 按 artifact catalog 时间线遍历本地已有产物：task 使用 `--kind task`，其余使用 `--kind artifact --artifact <file> --backfill`；最后用 `--kind summary --body-file <path>` 原地同步交付摘要。artifact backfill 在远端缺少 marker 时创建带“历史产物补发”提示的评论；已存在合法 marker 集合时保持原评论和分片不变并返回 `no-op`；marker 冲突仍失败。该判定由 core 完成，不由 Skill 扫描评论或拼标题。
