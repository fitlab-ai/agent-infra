# 任务短号

短号让所有 SKILL 在 active 任务生命周期内可以用 `#N` 替代完整的 22 字符
`TASK-YYYYMMDD-HHMMSS`。

## 语法

- 格式：`^#\d+$`（如 `#1`、`#7`、`#42`）；纯数字、不引入字母。
- `#0` 保留、永不分配。
- 不允许前导零（`#01` 非法）。
- 完整 `TASK-…` 入参在所有路径下行为与现状等价；`#N` 只是别名，不是持久化任务 ID。

## 生命周期

| 动作      | 触发时机                                                                                     | 注册表 / task.md 效应                                            |
|-----------|---------------------------------------------------------------------------------------------|------------------------------------------------------------------|
| alloc     | `create-task`、`import-issue`、`import-codescan`、`import-dependabot`                       | 分配最小可用 `#N`，写入 task.md 的 `short_id` 字段。              |
| resolve   | 生命周期 SKILL（`analyze-task` / `plan-task` / `code-task` / `review-*` / `commit` / …）    | `#N` → 完整 task id 查询，不分配。                              |
| release   | `complete-task`、`cancel-task`、`block-task`、`close-codescan`、`close-dependabot`          | 从注册表移除；task.md 的 `short_id` 字段保留作为历史值。          |
| re-alloc  | `restore-task`                                                                              | 重新分配（可能与历史不同），写入注册表与 task.md。               |

短号仅在任务处于 `.agents/workspace/active/` 期间有效；任务移动到
`completed/` / `blocked/` / `archive/` 后短号立即释放，可被新任务复用。

## 配置

```jsonc
// .agents/.airc.json
{
  "task": {
    "shortIdLength": 1  // 默认；容量 = 9（#1–#9）。改为 2 时容量 = #1–#99。
  }
}
```

当前位宽容量耗尽时，`alloc` 给出明确错误并建议「归档若干任务」或「调高
`task.shortIdLength`」两种修复路径；不静默扩位、不静默截断。

## `#N` 解析作用域（按入口二分）

| 入口                                                       | 注册表命中            | 注册表未命中                                            |
|-----------------------------------------------------------|----------------------|--------------------------------------------------------|
| SKILL 入参解析器（生命周期 SKILL）                          | 解析为完整 task id    | **严格报错** —— 短号不存在 / 格式错误                  |
| `ai sandbox enter '#N'` / `ai sandbox exec '#N' …`        | 解析为完整 task id    | 回退到 running sandbox 的 ls 行号语义（保留 #414 行为）|

`list --verify` 严格只读：报告 active 目录 / 注册表 / 各 task.md 的 `short_id`
三者差异，但不修改任何状态。

## 错误场景

- **短号不存在**：注册表中无 `#N`。可能是任务已归档（短号已释放）或输入错误。
- **注册表损坏**（同一 taskId 出现多次或 JSON 无法解析）：退出码 2，需人工处理。
- **参数格式错误**（如 `#0`、`#abc`、`#`）：退出码 1。

## 跨 TUI 引号要求

bash 中 `#` 是注释起始符，必须单引号：`ai sandbox exec '#3' 'npm test'`。
Claude Code / Codex / Gemini CLI / OpenCode 在加引号时都能把 `#N` 字面传递到
SKILL 的 `ARGUMENTS`。

## 冷启动迁移

升级 agent-infra 后，首次 `alloc` / `resolve` 调用会触发冷启动迁移：

- 所有 active task.md 缺 `short_id` 字段时自动补发并回写（仅修改 `short_id`
  一行，不刷新 `updated_at` / `agent_infra_version`，不追加 Activity Log）。
- 若 active 任务总数超过 `shortIdLength` 容量，**在任何写入之前**报错退出 2。
- 若 task.md 写入中途失败，`tx.commit()` 按缓存的原内容回滚所有已写文件（含
  `mtime` / `atime` 恢复）。
