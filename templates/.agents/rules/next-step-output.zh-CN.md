# 下一步输出规则

各 skill 在「告知用户」步骤渲染「下一步」命令与「任务信息」段时，统一按本规则呈现任务 ID 形态。渲染下一步前先读取本文件。

## 占位符语义

| 占位符 | 含义 | 渲染形态 |
|--------|------|----------|
| `{task-ref}` | 当前任务**短号** | 带 `#` 前缀，如 `#15`；取不到时回退完整 `TASK-id` |
| `{task-id}` | 当前任务**完整 ID** | `TASK-YYYYMMDD-HHMMSS` |

## 适用范围

- **下一步 TUI 命令**（`/analyze-task`、`/{{project}}:review-code`、`$create-pr` 等，含 Markdown 表格单元格内的命令）→ 一律用 `{task-ref}`（短号）。
- **「任务信息」/「任务状态」结构化字段行** → 完整 ID 与短号同显：`- 任务 ID：{task-id}（短号 {task-ref}）`。
- **报告标题**（`任务 {task-id} ... 完成`）与**产出文件路径**（`.agents/workspace/active/{task-id}/...`）→ 保持完整 `{task-id}`（物理路径与归档键，不可改）。

## 取短号（`{task-ref}`）

短号唯一真源是注册表 `.agents/workspace/active/.short-ids.json`（经 `task-short-id.js`）。**禁止**读取 task.md frontmatter 的 `short_id` 字段（该字段不可信）。

在已解析出完整 `$task_id` 后，用以下片段反查短号；命中返回 `#NN`，未命中自动回退完整 `TASK-id`：

```bash
task_ref=$(node -e '
const cp=require("child_process");
const out=cp.execSync("node .agents/scripts/task-short-id.js list",{encoding:"utf8"});
const ids=(JSON.parse(out).ids)||{};
const full=process.argv[1];
const hit=Object.entries(ids).find(([,v])=>v===full);
process.stdout.write(hit?("#"+hit[0]):full);
' "$task_id")
# 示例：$task_id=TASK-20260613-225809 -> task_ref=#15
```

## 回退条件

`{task-ref}` 在以下情况回退为完整 `TASK-id`（即注册表查不到对应短号）：

- **未分配**：任务尚未经 `create-task` / `import-*` / `restore-task` 分配短号的极早期路径。
- **已释放**：任务经 `complete-task` / `cancel-task` / `block-task` / `close-codescan` / `close-dependabot` 归档后，短号立即从注册表移除。这些归档类 skill 的终态/摘要行因此自然回退完整 `TASK-id`，无需特判。

`restore-task` 恢复任务时会重新分配短号（可能与历史不同），片段会取到新短号。

## `#` 前缀与 shell 引用

短号统一渲染为带 `#` 前缀的 `#NN`，与 task.md frontmatter 的 `short_id` 渲染一致。`#` 在 bash 中是注释起始符，示例命令若直接粘贴需视 TUI 而定（裸数字 `NN` 与 `#NN` 都被 `task-short-id.js resolve` 接受）。

## 完成时间收尾行（Completed at）

所有读取本规则、并向用户渲染「下一步 / 告知用户」输出的 skill，在面向用户输出的**绝对最后一行**统一追加一行完成时间，便于用户在 tmux 多窗口扫视时一眼判断各 Agent 的完成先后：

```text
Completed at: YYYY-MM-DD HH:mm:ss
```

- 取值命令（本地时区、不带偏移）：`date "+%Y-%m-%d %H:%M:%S"`
- 位置：必须是整段面向用户输出的最后一行，排在所有「下一步」命令之后。若某场景在命令之后还有条件性提醒行（如 env-blocked 提醒），收尾行排在该提醒行之后。
- 该行只用于终端扫视，不写入任何产物文件或 Issue/PR 评论；完成时刻的单一事实源仍是 task.md 的 Activity Log。
