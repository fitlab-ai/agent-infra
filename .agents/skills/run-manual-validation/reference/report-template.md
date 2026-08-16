# 验证运行证据

## 状态核对

```text
$ agent-infra-internal task-snapshot {task-id} --format text
{raw-output}
```

## 验证目标

{target-and-coverage}

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

## 清理与恢复

{cleanup-and-recovery-result}

## 尚未覆盖

{remaining-manual-validation-items}

## 证据原文

```text
$ ai task validate {task-ref} --scope {scope} --format json -- {redacted-command}
{sanitized-result}
```
