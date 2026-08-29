# PR 平台意图命令

> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」。

PR 资源的定位、创建、绑定和元数据同步统一通过 typed internal intent；SKILL 只负责决定分支、标题、正文和调用时机，不直接拼装平台命令。

## 定位

```bash
agent-infra-internal platform-pr inspect {task-id}
```

返回已绑定 PR 的规范身份；未绑定时返回 `PR_NOT_LINKED`。调用方不得按标题模糊匹配。

## 创建或恢复

调用方把标题和正文分别写入临时文件，然后执行：

```bash
agent-infra-internal platform-pr create {task-id} \
  --agent {standard-agent-token} --base {target-branch} --head {current-branch} \
  --title-file {title-file} --body-file {body-file}
```

core 会先按 upstream、head 和 base 精确定位；唯一既有 PR 会复用并绑定，零个才创建，多个稳定失败。远端结果未知时重新精确定位，不盲重建。`--dry-run` 只返回计划。

## 显式绑定

```bash
agent-infra-internal platform-pr bind {task-id} --pr {pr-number} --agent {standard-agent-token}
```

冲突绑定稳定失败且不修改 `task.md`。

## 元数据同步

```bash
agent-infra-internal platform-pr sync {task-id} \
  --agent {standard-agent-token} --metadata --closing-issue
```

core 从关联 Issue 复制 type / `in:` labels、assignee、具体 milestone，并确保 closing association。权限不足返回逐项 `skipped` 和顶层 `degraded`；不得反向修改 Issue。

## 状态语义

- `planned|applied|no-op|degraded`：退出码 0。
- `failed`：退出码 1，确定性输入或远端错误。
- `blocked`：退出码 2，网络、认证或结果未知，需要人工介入或安全重跑。
- 创建后摘要或元数据同步失败不得回滚 PR；调用方按所属 SKILL 记录 warning。
