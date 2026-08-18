# 验证运行证据

## 输入模式

- 模式：`{explicit|automatic}`
- 输入判定：{sanitized-input-decision}
- PR 来源状态：`{success|no-op|failed|blocked}` / `{stable-code-or-none}`

## 状态核对

```text
$ agent-infra-internal task-snapshot {task-id} --format text
{raw-output}
```

## 验证目标

{target-and-coverage}

## 发现清单

| ID | 来源 | 目标 | 所需能力 | 预期断言 | 分类 |
|----|------|------|----------|----------|------|
| `MV-{N}` | `{review-code|pr|merged|explicit}` | {target} | {capability} | {expected-assertion} | `{executable|unavailable|unknown|unsafe|unresolved}` |

## 模式判定

- 模式：`{snapshot|inplace}`
- 依据：{reason}
- 运行时升级：{none-or-reason}

## 命令摘要

- 命令名称：`{basename-only}`
- 不记录完整 argv、环境变量或原始输出。

## 结构化证据

```json
{sanitized-ai-task-validate-json}
```

## 逐项结果

### MV-{N}

- 来源：`{source}`
- 分类：`{classification}`
- Scope：`{snapshot|inplace|not-run}`
- 命令名称：`{basename-only|not-run}`
- 退出状态：`{exit-status|not-run}`
- 运行时升级：{none-or-reason}
- 结果：{sanitized-result-or-coverage-gap}
- Cleanup：{cleanup-result}

## 清理与恢复

{cleanup-and-recovery-result}

## 尚未覆盖

{remaining-manual-validation-items}

## 证据原文

```text
$ ai task validate {task-ref} --scope {scope} --format json -- {redacted-command}
{sanitized-result}
```
