# Issue 同步规则

## Marker 注册表

| Key | Marker |
|---|---|
| `task` | `<!-- sync-issue:{task-id}:task -->` |
| `artifact` | `<!-- sync-issue:{task-id}:{artifact-stem} -->` |
| `artifactChunk` | `<!-- sync-issue:{task-id}:{artifact-stem}:{part}/{total} -->` |
| `summary` | `<!-- sync-issue:{task-id}:summary -->` |
| `cancel` | `<!-- sync-issue:{task-id}:cancel -->` |

调用方只传 marker key/资源，不自行拼 marker。PR summary 属于 `.agents/rules/pr-sync.md`。

## 平台 intent

```bash
agent-infra-internal platform-context resolve [--cwd <path>]
agent-infra-internal platform-comment list --issue <N> [--cwd <path>]
agent-infra-internal platform-comment owner <task-ref>
agent-infra-internal platform-comment sync <task-ref> \
  --kind task|artifact|summary|cancel --agent <agent> \
  [--artifact <canonical.md>] [--body-file <path|->] [--backfill]
```

typed core 统一处理 upstream、认证、capability、分页、marker、幂等写入、分片、重试和错误分类。`applied|no-op|degraded` 退出 0，`failed` 退出 1，`blocked` 退出 2。重复 marker 返回 `COMMENT_MARKER_CONFLICT`；外部贡献者锁定使用 `platform-comment owner`。

## 降级与 08/10 边界

评论失败通过 `task-warning` 映射为 `PERMISSION_DEGRADED`、`COMMENT_SYNC_FAILED` 或 `NETWORK_RETRY_EXHAUSTED`。Issue label、milestone、assignee、Issue Type、fields 和需求复选框仍属于 08/10 元数据兼容区；按 `capabilities.triage/push` 降级，不阻断评论 intent。

```bash
agent-infra-internal task-warning {task-id} add \
  --step issue-sync --severity {severity} --code {code} \
  --target {target} --message {message} --action {action}
```

complete-task 按 artifact catalog 调用 `--kind task`、`--kind artifact --backfill`，最后以 `--kind summary --body-file` 同步摘要；Skill 不扫描评论或拼标题。
