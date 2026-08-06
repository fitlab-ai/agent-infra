# Issue 字段

> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」：标准 AI 短名（`claude`/`codex`/`antigravity`/`opencode`/`cursor`）、长名归一化（`claude-code`→`claude`、`antigravity-cli`→`antigravity`）或人工例外 `human`。

Issue Type 与 pinned fields 统一由 `platform-issue` intent 动态读取组织 schema 并同步：

```bash
agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --issue-type --fields
```

## 支持字段

| task.md 字段 | Issue 字段 | 值格式 |
|---|---|---|
| `priority` | `Priority` | `Urgent`、`High`、`Medium`、`Low`，支持紧急/高/中/低本地化输入 |
| `effort` | `Effort` | `High`、`Medium`、`Low`，支持高/中/低本地化输入 |
| `start_date` | `Start date` | `YYYY-MM-DD` |
| `target_date` | `Target date` | `YYYY-MM-DD` |

适配层每次从组织读取当前 Issue Type schema，不硬编码 Type、field 或 option ID。Type 变化时按字段名迁移仍受支持的值，并清理目标 Type 不再支持的旧字段。个人仓库或 `push=false` 时只跳过 Type/fields operations，其他同步继续。

调用方只声明业务时机，不直接拼 GraphQL；结果和错误处理遵循 `.agents/rules/issue-sync.md`。
