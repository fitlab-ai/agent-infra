---
name: import-issue
description: >
  从 Issue 导入并创建任务。
  当想从既有 Issue 开工并在本地跟踪时使用。
---

# 导入 Issue

导入指定的 Issue 并创建任务。参数：issue 编号。

## 行为边界 / 关键规则

- 本技能的唯一产出是 `task.md`
- 不要编写或修改业务代码。仅做导入
- 执行本技能后，你**必须**立即更新任务状态

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：记录开始时间

本技能会**创建** task.md，开始时尚无文件可写。先在内存记录开始时间 `started_at`（`date "+%Y-%m-%d %H:%M:%S%:z"`）；在最后写活动日志时**一次性补两条**——started 行用 `started_at`、done 行用完成时间，二者同基名（started 行 action 加 ` [started]` 后缀、note 用 `started`）。基名必须跟实际导入场景一致：

```
# 场景 B：新 Issue 导入
- {started_at} — **Import Issue [started]** by {agent} — started
- {done_at} — **Import Issue** by {agent} — {完成说明}

# 场景 C：从历史 Issue 评论恢复
- {started_at} — **Import Issue (Recovered) [started]** by {agent} — started
- {done_at} — **Import Issue (Recovered)** by {agent} — {完成说明}
```

`ai task log` 会按基名把两条配对成一行（进行中 → 已完成）。约定见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

## 执行流程

### 1. 获取 Issue 信息

执行前先读取 `.agents/rules/issue-pr-commands.md`，并按其中的前置步骤完成认证和代码托管平台检测；随后按其中的 “读取 Issue” 命令获取 Issue 信息。

提取：issue 编号、标题、描述、标签。

从 Issue 标题派生任务标题：按下方契约剥掉可选的单层前导 Conventional Commits 前缀，其余描述原文与原始语言保持不变。下方 fenced 契约是权威的、与语言无关的规则——在所有 `import-issue` 变体中保持逐字节一致：

```
# title-derivation-contract
strip-prefix: type(scope):
prefix-types: feat fix docs style refactor perf test build ci chore revert
single-layer-only: true
preserve-body-colon: true
keep-when-no-prefix: true
example-strip: "feat(meta): create-pr summary" => "create-pr summary"
example-keep: "修复某问题" => "修复某问题"
example-single-layer: "feat: add A: B" => "add A: B"
```

只剥第一层前缀，且仅当前导 token 是 `prefix-types` 之一、其后可带 `(scope)` 与 `!`，再接 `:` 和至少一个空格；描述正文中的冒号永远不算前缀。

### 2. 检查已有任务

2.1 搜索 `.agents/workspace/active/` 中是否已有链接到此 Issue 的任务。
- 如果找到，**默认复用现有任务**（场景 A），不询问用户；在最终告知中明确「已复用现有任务 `{task-id}`，未重新导入」。若用户希望重新导入，需要先手动归档/删除已有任务再次执行本技能
- 如果未找到，继续执行 2.2

2.2 按 `.agents/rules/issue-pr-commands.md` 的“历史任务评论扫描”命令扫描 Issue 评论中的同步标记，查找可恢复的历史任务 ID。

该命令依赖步骤 1 已设置的 `$upstream_repo`。

退出码处理（pipeline 整体）：

- 退出 0 + 输出 `found=false`：按新 Issue 导入流程创建新任务
- 退出 0 + 输出 `found=true`：复用 `task_id`
- 退出非 0（平台 API、认证、JSON 解析或任一段管道异常）：视为 platform API 降级，向用户展示 stderr 后按新 Issue 导入流程继续，不阻塞导入

### 3. 创建任务目录和文件

3.1 决定 task ID 和 `created_at`。

| 场景 | 触发条件 | task ID 来源 | created_at 来源 | 用户确认 |
|---|---|---|---|---|
| 场景 A | 2.1 命中本地任务 | 复用本地 ID | 本地保留 | 默认复用，不询问；告知用户已复用 |
| 场景 B | 2.1 无命中 + 2.2 无候选 | `date +%Y%m%d-%H%M%S` 新建 | 当前时间 | 不需要 |
| 场景 C | 2.1 无命中 + 2.2 有候选 | 自动复用最早候选 ID | 优先用远端 frontmatter 的 `created_at`，缺失时用当前时间 | 告知即可 |

```bash
date +%Y%m%d-%H%M%S
```

3.2 写入任务目录和 `task.md`。

- 创建目录：`.agents/workspace/active/{task-id}/`
- 使用 `.agents/templates/task.md` 模板创建 `task.md`
- 场景 C 优先沿用远端 frontmatter 中的 `type`、`workflow`、`branch`、`milestone`；缺失或损坏字段按 Issue 标签和当前规则重新推断
- `current_step` 始终写入 `requirement-analysis`，不要恢复为远端原 `current_step`

任务元数据：
```yaml
id: {task-id}
issue_number: <issue-number>
type: feature|bugfix|refactor|docs|chore
branch: <project>-<type>-<slug>
workflow: feature-development|bug-fix|refactoring
status: active
created_at: {YYYY-MM-DD HH:mm:ss±HH:MM}
updated_at: {YYYY-MM-DD HH:mm:ss±HH:MM}
agent_infra_version: {agent_infra_version}
priority:                  # 可选；有来源/frontmatter 值时保留
effort:                    # 可选；有来源/frontmatter 值时保留
start_date:                # 可选；有明确 YYYY-MM-DD 时保留
target_date:               # 可选；有明确 YYYY-MM-DD 时保留
current_step: requirement-analysis
assigned_to: {当前 AI 代理}
```

可选 Issue 字段元数据应保留恢复得到或来源中明确给出的值。缺失时留空；不要臆测日期。

3.3 追加 Activity Log。

- 场景 B：追加 `Import Issue`
- 场景 C：追加 `Import Issue (Recovered)`，注明恢复的 task ID、可恢复的原 `current_step`、原 `assigned_to`，并说明 `current_step` 已重置为 `requirement-analysis`；如果部分 frontmatter 字段缺失或损坏，在同一条记录中注明 fallback

### 4. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `current_step`：requirement-analysis
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- `agent_infra_version`：按 `.agents/rules/version-stamp.md` 取值
- `## 上下文` 中的 `- **分支**：`：更新为生成的分支名
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Import Issue** by {agent} — Issue #{number} imported
  ```
  如果步骤 3.3 已经按恢复场景追加了 Activity Log，不要重复追加同义记录。

### 5. 分配 Issue Assignee

如果 task.md 中存在有效的 `issue_number`，按 `.agents/rules/issue-pr-commands.md` 的 Issue 更新命令为当前执行者添加 assignee；Assignee 同步的边界仍遵循 `.agents/rules/issue-sync.md`。

### 6. 同步到 Issue

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续）：
- 执行前先读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测
- 检查 Issue 当前 milestone；如果未设置，先读取 `.agents/rules/milestone-inference.md`，按其中的「阶段 1：`create-task`（平台规则创建 Issue 时）」推断版本线，并按其「`import-issue` 调用时的兜底」子节执行远端回写；推断失败、权限不足或回写失败均跳过并继续，不阻断导入
- 所有场景结束后，必须执行一次 task 留言同步，创建或更新 `.agents/rules/issue-sync.md` 中定义的 task 评论标记，确保远端 `:task` 评论存在且内容与本地 `task.md` 一致（按 issue-sync.md 的 task.md 评论同步规则）

### 7. 完成校验

**先调用短号分配**（保证注册表 entry 已分配；完成校验阶段会读取）：

```bash
node .agents/scripts/task-short-id.js alloc "$task_id"
```

如失败（退出码非 0），按提示「归档若干任务」或「调高 task.shortIdLength」处理；不要继续执行后续步骤。

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate import-issue .agents/workspace/active/{task-id} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 8. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。 渲染最终输出前，先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令把 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

```
Issue #{number} 已导入。

任务信息：
- 任务 ID：{task-id}（短号 {task-ref}）
- 标题：{title}
- 工作流：{workflow}

产出文件：
- 任务文件：.agents/workspace/active/{task-id}/task.md

下一步 - 执行需求分析：
  - Claude Code / OpenCode：/analyze-task {task-ref}
  - Gemini CLI：/agent-infra:analyze-task {task-ref}
  - Codex CLI：$analyze-task {task-ref}
```



## 完成检查清单

- [ ] 创建了任务文件 `.agents/workspace/active/{task-id}/task.md`
- [ ] 在 task.md 中记录了 issue_number
- [ ] 更新了 `current_step` 为 requirement-analysis
- [ ] 更新了 `updated_at` 为当前时间
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 同步了 task 评论到 Issue，且远端内容与本地 task.md 一致
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，含自定义 TUI，不要筛选）
- [ ] **没有修改任何业务代码**

## 停止

完成检查清单后，**立即停止**。不要继续执行后续步骤。

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 注意事项

1. **Issue 验证**：在继续之前检查 Issue 是否存在
2. **重复任务**：如果此 Issue 已有关联任务，**默认复用**而非创建新任务（不询问用户）
3. **下一步**：导入完成后，先执行 `analyze-task`，再进入 `plan-task`

## 错误处理

- Issue 未找到：提示 "Issue #{number} not found, please check the issue number"
- 网络错误：提示 "Cannot connect to the platform, please check network"
- 权限错误：提示 "No access to this repository"
