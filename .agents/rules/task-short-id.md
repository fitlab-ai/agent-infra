# 任务短号

短号让所有 SKILL 在 active 任务生命周期内可以用 `#NN` 替代完整的 22 字符
`TASK-YYYYMMDD-HHMMSS`。

## 语法

- 格式：`^#\d{shortIdLength}$`（**零填充到固定宽度**；默认 `shortIdLength=2` 时
  形如 `#01`、`#07`、`#42`）。
- **必须**零填充到 `shortIdLength` 位（默认 2 位：`#1` 视为格式错误，应输入
  `#01`）。这是为了视觉对齐与盲打体验。
- `#00`（或 `shortIdLength=1` 时 `#0`）保留、永不分配；纯数字、不引入字母。
- 完整 `TASK-…` 入参在所有路径下行为与现状等价；`#NN` 只是别名，不是持久化任务 ID。

## 生命周期

| 动作      | 触发时机                                                                                     | 注册表 / task.md 效应                                            |
|-----------|---------------------------------------------------------------------------------------------|------------------------------------------------------------------|
| alloc     | `create-task`、`import-issue`、`import-codescan`、`import-dependabot`                       | 分配最小可用 `#NN`，写入 task.md 的 `short_id` 字段。              |
| resolve   | 生命周期 SKILL（`analyze-task` / `plan-task` / `code-task` / `review-*` / `commit` / …）    | `#NN` → 完整 task id 查询，不分配。                              |
| release   | `complete-task`、`cancel-task`、`block-task`、`close-codescan`、`close-dependabot`          | 从注册表移除；task.md 的 `short_id` 字段保留作为历史值。          |
| re-alloc  | `restore-task`                                                                              | 重新分配（可能与历史不同），写入注册表与 task.md。               |

短号仅在任务处于 `.agents/workspace/active/` 期间有效；任务移动到
`completed/` / `blocked/` / `archive/` 后短号立即释放，可被新任务复用。

## 配置

```jsonc
// .agents/.airc.json
{
  "task": {
    "shortIdLength": 2  // 默认；容量 = 99（#01–#99）。改为 3 时容量 = #001–#999。
  }
}
```

当前位宽容量耗尽时，`alloc` 给出明确错误并建议「归档若干任务」或「调高
`task.shortIdLength`」两种修复路径；不静默扩位、不静默截断。
切换 `shortIdLength` 配置需要先归档所有 active 任务（注册表 key 宽度依赖配置）。

## `#NN` 解析作用域（按入口二分）

| 入口                                                       | 注册表命中            | 注册表未命中                                            |
|-----------------------------------------------------------|----------------------|--------------------------------------------------------|
| SKILL 入参解析器（生命周期 SKILL）                          | 解析为完整 task id    | **严格报错** —— 短号不存在 / 格式错误                  |
| `ai sandbox enter '#NN'` / `ai sandbox exec '#NN' …`      | 解析为完整 task id    | 回退到 running sandbox 的 ls 行号语义（保留 #414 行为）|

`list --verify` 严格只读：报告 active 目录 / 注册表 / 各 task.md 的 `short_id`
三者差异，但不修改任何状态。

## SKILL 入参解析

任意 SKILL（含 alloc / resolve / release / re-alloc 四类生命周期入口）在收到
`{task-id}` 入参后，必须按以下契约处理：

1. 如果 `{task-id}` 字面以 `#` 开头：

```bash
if [[ "{task-id}" == "#"* ]]; then
  # 脚本本身已输出完整错误（含「expected #NN (N-digit zero-padded; e.g. '#01')」）；
  # 调用方只需透传退出码
  task_id=$(node .agents/scripts/task-short-id.js resolve "{task-id}") || exit 1
else
  task_id="{task-id}"
fi
```

2. 后续所有命令把 `{task-id}` 视为 `$task_id`（已是完整 `TASK-YYYYMMDD-HHMMSS` 形式）
3. 解析失败的退出码语义参见「错误场景」段；不要在 SKILL 中重写错误处理

## 存储位置

短号系统跨两处持久化状态，二者在稳态时一一对应：

| 位置 | 写入时机 | 读取时机 | 删除时机 |
|---|---|---|---|
| `.agents/workspace/active/.short-ids.json`（注册表） | `alloc` / 冷启动迁移 | `resolve` 唯一权威源 / `list` / `list --verify` | `release` / 冷启动 stale 清理 |
| 各 task.md frontmatter 的 `short_id` 字段 | `alloc` / 冷启动迁移 | `list --verify`（比对一致性） | **永不删除**（归档后保留为历史值） |

**注册表**：

- 路径：`<repo-root>/.agents/workspace/active/.short-ids.json`
- Schema：`{ "version": 1, "ids": { "01": "TASK-20260609-192644", "02": "TASK-…" } }`
- key 是零填充到 `task.shortIdLength` 位的字符串，value 是完整 `TASK-…` task id
- 自动 git ignore（active 工作区整体 ignore；无需新增 ignore 条目）
- 首次 `alloc` / `resolve` 时按需自动创建；不存在时按空注册表处理

**task.md `short_id` 字段**：

- 在 frontmatter 中、紧跟 `id` 字段之后；格式 `short_id: #01`
- 与注册表 key 字面一致（含 `#` 前缀）
- 归档（complete-task / cancel-task / block-task / close-*）后：注册表 entry 立即
  删除（短号可被新任务复用），但 task.md `short_id` 字段保留作为历史值。解析器
  只信任注册表
- 冷启动迁移：升级 agent-infra 后首次 alloc / resolve 路径会扫描所有 active
  目录并为缺字段的 task.md 补发短号；补发受字段保护约束（不刷新
  `updated_at` / `agent_infra_version`、不追加 Activity Log）

`resolve('#NN')` 工作流：① 校验入参严格匹配 `^#\d{shortIdLength}$` → ② 直接以
`NN` 作为 key 查注册表 `ids` → ③ 命中返回完整 task id，未命中按 `list --verify`
给出修复指引退出 1。

## 错误场景

- **短号不存在**：注册表中无 `#NN`。可能是任务已归档（短号已释放）或输入错误。
- **注册表损坏**（同一 taskId 出现多次或 JSON 无法解析）：退出码 2，需人工处理。
- **参数格式错误**（如 `#00`、`#abc`、`#`、`#1` 当 `shortIdLength=2` 时）：退出码 1。

## 跨 TUI 引号要求

bash 中 `#` 是注释起始符，必须单引号：`ai sandbox exec '#03' 'npm test'`。
Claude Code / Codex / Gemini CLI / OpenCode 在加引号时都能把 `#NN` 字面传递到
SKILL 的 `ARGUMENTS`。

## 冷启动迁移

升级 agent-infra 后，首次 `alloc` / `resolve` 调用会触发冷启动迁移：

- 所有 active task.md 缺 `short_id` 字段时自动补发并回写（仅修改 `short_id`
  一行，不刷新 `updated_at` / `agent_infra_version`，不追加 Activity Log）。
- 若 active 任务总数超过 `shortIdLength` 容量，**在任何写入之前**报错退出 2。
- 若 task.md 写入中途失败，`tx.commit()` 按缓存的原内容回滚所有已写文件（含
  `mtime` / `atime` 恢复）。
