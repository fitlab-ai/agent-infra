# 任务短号

短号让所有 SKILL 在 active 任务生命周期内可以用 `#NN` 或裸数字 `N`（推荐）替代
完整的 22 字符 `TASK-YYYYMMDD-HHMMSS`。

## 语法

- 字面接受两种等价形式：
  - **裸数字 `N`**（推荐，无需 shell 引号）：如 `1`、`7`、`42`。
  - **`#`-前缀 `#N` / `#NN`**（也接受；但 bash 需 `'...'` 引号）：如 `#1`、`#01`、`#42`。
- 解析规则：去前导零后取数值 `n`，若 `n == 0` 报错（保留）；若 `n > 10^shortIdLength - 1`
  报错（超容量）；否则归一化为 `#${n.padStart(shortIdLength, '0')}`，作为注册表 key。
- 默认 `shortIdLength=2` 时容量 `n ∈ [1, 99]`，注册表 key 形如 `01`、`07`、`42`。
- `#00`（或 `shortIdLength=1` 时 `#0`）保留、永不分配；纯数字、不引入字母。
- 完整 `TASK-…` 入参在所有路径下行为与现状等价；`#NN` / 裸数字只是别名，不是持久化任务 ID。

## 生命周期

| 动作      | 触发时机                                                                                     | 注册表效应                                                       |
|-----------|---------------------------------------------------------------------------------------------|------------------------------------------------------------------|
| alloc     | `create-task`、`import-issue`、`import-codescan`、`import-dependabot`                       | 分配最小可用 `#NN`，写入注册表。                                  |
| resolve   | 生命周期 SKILL（`analyze-task` / `plan-task` / `code-task` / `review-*` / `commit` / …）    | `#NN` → 完整 task id 查询，不分配。                              |
| release   | `complete-task`、`cancel-task`、`block-task`、`close-codescan`、`close-dependabot`          | 从注册表移除。                                                   |
| re-alloc  | `restore-task`                                                                              | 重新分配（可能与历史不同），写入注册表。                         |

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
| `ai sandbox exec <N \| '#N'>` / `ai sandbox create <N \| '#N'>`           | 解析为完整 task id 后查 task.md 取 `branch` | **严格报错** —— 不再回退到 ls 行号或字面分支名；提示用任务短号 / `TASK-id` / 分支名 |

`list --verify` 严格只读：报告 active 目录 / 注册表 两者差异，但不修改任何状态。

## SKILL 入参解析

任意 SKILL（含 alloc / resolve / release / re-alloc 四类生命周期入口）在收到
`{task-id}` 入参后，必须按以下契约处理：

1. 如果 `{task-id}` 字面匹配 `^[#]?[0-9]+$`（裸数字 `N` 或 `#`-前缀 `#N`）：

```bash
if [[ "{task-id}" =~ ^[#]?[0-9]+$ ]]; then
  # 脚本本身已输出完整错误（含 reserved / exceeds shortIdLength capacity 等场景）；
  # 调用方只需透传退出码
  task_id=$(node .agents/scripts/task-short-id.js resolve "{task-id}") || exit 1
else
  task_id="{task-id}"
fi
```

2. 后续所有命令把 `{task-id}` 视为 `$task_id`（已是完整 `TASK-YYYYMMDD-HHMMSS` 形式）
3. 解析失败的退出码语义参见「错误场景」段；不要在 SKILL 中重写错误处理

## 存储位置

短号是纯本地状态，唯一持久化在注册表 `.agents/workspace/active/.short-ids.json`，task.md 不持有短号：

- 路径：`<repo-root>/.agents/workspace/active/.short-ids.json`
- Schema：`{ "version": 1, "ids": { "01": "TASK-20260609-192644", "02": "TASK-…" } }`
- key 是零填充到 `task.shortIdLength` 位的字符串，value 是完整 `TASK-…` task id
- 自动 git ignore（active 工作区整体 ignore；无需新增 ignore 条目）
- 首次 `alloc` 时按需自动创建；不存在时按空注册表处理
- 短号只由显式 `alloc`（`create-task` / `import-*` / `restore-task`）分配；`resolve` / `list` / `release` 不分配，仅在执行时自动清理指向非 active 任务的 stale entry
- 归档（complete-task / cancel-task / block-task / close-*）后注册表 entry 立即删除，短号可被新任务复用；归档后引用任务一律用完整 `TASK-…` id

`resolve(<N|'#N'>)` 工作流：① 校验入参匹配 `^[#]?[0-9]+$` → ② 去前导零取
数值 `n`，按 `n` 是否 `== 0`（保留）/ `> 10^shortIdLength - 1`（超容量）/
正常 三类处理 → ③ 正常时以 `n.padStart(shortIdLength, '0')` 作为 key 查
注册表 `ids` → ④ 命中返回完整 task id，未命中按 `list --verify` 给出修复指引退出 1。

## 错误场景

- **短号不存在**：注册表中无对应 key。可能是任务已归档（短号已释放）或输入错误。退出码 1。
- **注册表损坏**（同一 taskId 出现多次或 JSON 无法解析）：退出码 2，需人工处理。
- **保留键**：解析后 `n == 0`（输入如 `0`、`#0`、`#00`）。退出码 1。
- **超容量**：解析后 `n > 10^shortIdLength - 1`（如 `shortIdLength=2` 下 `100` 或 `#100`）。退出码 1。
- **参数格式错误**：入参既不是 `^[#]?[0-9]+$` 也不是 `TASK-id`（如 `#abc`、`#`、`5.5`）。退出码 1。

## 跨 TUI 引号要求

裸数字 `N` 在所有 shell 与 TUI 中都安全无需引号，推荐写法：
`ai sandbox exec 11 'npm test'`、`/review-analysis 11`。

`#N` / `#NN` 写法也接受；但 bash 中 `#` 是注释起始符，必须单引号：
`ai sandbox exec '#03' 'npm test'`。Claude Code / Codex / Gemini CLI / OpenCode
在加引号时都能把 `#NN` 字面传递到 SKILL 的 `ARGUMENTS`。
