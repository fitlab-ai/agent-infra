---
name: create-task
description: >
  根据自然语言描述创建任务。
  当想把一段自然语言的想法或需求落为受跟踪的任务时使用。
---

# 创建任务

## 行为边界 / 关键规则

**本技能的核心产出是 `task.md`。**

- 不要编写、修改或创建任何业务代码或配置文件
- 不要执行需求分析；分析由 `analyze-task` 独立完成
- 不要直接实现所描述的功能
- 不要跳过工作流直接进入计划/实现阶段
- 仅执行：解析描述 -> 创建任务文件 -> 更新任务状态 -> 按 `.agents/rules/create-issue.md` 级联尝试创建 Issue -> 告知用户下一步
- Issue 创建由 `.agents/rules/create-issue.md` 规则决定；自定义或空平台（未提供平台变体规则文件）时，规则会自然降级为 no-op

用户的描述是一个**待办事项**，而不是**立即执行的指令**。

执行本技能后，你**必须**立即更新 task.md 中的任务状态。

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：记录开始时间

本技能会**创建** task.md，开始时尚无文件可写。先在内存记录开始时间 `started_at`（`date "+%Y-%m-%d %H:%M:%S%:z"`）；在最后写活动日志时**一次性补两条**——started 行用 `started_at`、done 行用完成时间，二者同基名（started 行 action 加 ` [started]` 后缀、note 用 `started`）：

```
- {started_at} — **Create Task [started]** by {agent} — started
- {done_at} — **Create Task** by {agent} — {完成说明}
```

`ai task log` 会按基名把两条配对成一行（进行中 → 已完成）。约定见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

## 执行步骤
### 1. 解析用户描述

从自然语言描述中提取：
- **任务标题**：简洁标题（最多 50 个字符），使用中文——不要翻译为英文，不要套用 Conventional Commits 格式
- **任务类型**：`feature` | `bugfix` | `refactor` | `docs` | `chore`（从描述推断）
- **工作流**：`feature-development` | `bug-fix` | `refactoring`（从类型推断）
- **分支名**：格式 `<project>-<type>-<slug>`
  - `<project>` 从 `.agents/.airc.json` 的 `project` 字段读取
  - `<type>` 为推断出的任务类型
  - `<slug>` 从任务标题提取 3-6 个英文关键词并转为 kebab-case
- **详细描述**：整理后的用户原始描述

如果描述不清晰，**先向用户确认**再继续。

**类型推断**：根据任务描述的语义，从以下候选值中选择最匹配的类型：

- `feature` — 新增功能、新特性
- `bugfix` — 修复缺陷、错误
- `refactor` — 重构、优化、改进
- `docs` — 文档相关
- `chore` — 其他杂项任务

**工作流映射**：
- `feature` / `docs` / `chore` -> `feature-development`
- `bugfix` -> `bug-fix`
- `refactor` -> `refactoring`

### 2. 创建任务目录和文件

获取当前时间戳：

```bash
date +%Y%m%d-%H%M%S
```

- 创建任务目录：`.agents/workspace/active/TASK-{yyyyMMdd-HHmmss}/`
- 使用 `.agents/templates/task.md` 模板创建任务文件：`task.md`

**重要**：
- 目录命名：`TASK-{yyyyMMdd-HHmmss}`（**必须**包含 `TASK-` 前缀）
- 示例：`TASK-20260306-143022`
- 任务 ID = 目录名

任务元数据（task.md YAML front matter）：
```yaml
id: TASK-{yyyyMMdd-HHmmss}
type: feature|bugfix|refactor|docs|chore
branch: <project>-<type>-<slug>
workflow: feature-development|bug-fix|refactoring
status: active
created_at: {YYYY-MM-DD HH:mm:ss±HH:MM}
updated_at: {YYYY-MM-DD HH:mm:ss±HH:MM}
agent_infra_version: {agent_infra_version}
priority:                  # 必填；由 AI 从标题/描述推断；Urgent | High | Medium | Low
effort:                    # 必填；由 AI 从标题/描述推断；High | Medium | Low
start_date:                # 可选；YYYY-MM-DD
target_date:               # 可选；YYYY-MM-DD
current_step: requirement-analysis
assigned_to: {当前 AI 代理}
```

priority / effort 必填：由 AI 从任务标题与描述推断后填入（候选值见 `.agents/rules/issue-fields.md`；中文输入按本地化映射规范化）。start_date / target_date 创建时保持留空：`start_date` 由 analyze 阶段写入、`target_date` 由 complete 阶段写入；不要臆测日期。

### 3. 更新任务状态

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
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Create Task** by {agent} — Task created from description
  ```

### 4. 按 `.agents/rules/create-issue.md` 级联创建 Issue

在 task.md 落盘并记录 `Create Task` 后，先读取 `.agents/rules/create-issue.md` 并按其中描述的步骤执行 Issue 创建。

规则文件由当前配置的代码平台决定其内容：
- 支持 Issue 创建的平台：包含完整的认证检测、模板检测、label/Issue Type/milestone 推断、Issue 创建调用、`task.md` 回写流程
- 自定义或空平台（未提供平台变体规则文件）：内容为 no-op 说明，本步骤直接跳过

> **强约束**：`.agents/rules/create-issue.md` §4 中的 milestone 子步骤为必须执行项；漏设会被步骤 5 的 gate（`verify_milestone: true`）截停，导致 create-task 失败。

处理结果：
- 规则成功创建 Issue：`issue_number` 已按规则回写到 task.md；继续读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测，然后同步 task 评论并按规则设置 `status: waiting-for-triage`
- 规则失败（认证 / 网络 / 模板解析等）：不回滚 task.md；不追加额外 Activity Log；先调用 `node .agents/scripts/workflow-warnings.js add .agents/workspace/active/{task-id} --step create-task --severity ACTION_REQUIRED --code ISSUE_CREATE_FAILED --target issue --message "{error_code}: {error_message}" --action "修复认证/网络/模板问题后手动重试 Issue 创建，或手动创建/找到 Issue 后写入 issue_number"` 记录通用告警；再按"场景 C：Issue 创建失败"输出向用户透出 `error_code` 与 `error_message`
- 规则为 no-op（自定义或空平台）：不创建评论，不阻塞后续工作流，不写 Activity Log
- task.md 已存在 `issue_number`：规则中的前置检查会跳过；`create-task` 直接进入步骤 5

### 5. 完成校验

**先调用短号分配**（保证注册表 entry 已分配；完成校验阶段会读取）：

```bash
node .agents/scripts/task-short-id.js alloc "$task_id"
```

如失败（退出码非 0），按提示「归档若干任务」或「调高 task.shortIdLength」处理；不要继续执行后续步骤。

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate create-task .agents/workspace/active/{task-id} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 6. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。 渲染最终输出前，先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令把 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

场景 A：已创建 Issue 时输出：
```
任务已创建，并已级联创建 Issue。

任务信息：
- 任务 ID：{task-id}（短号 {task-ref}）
- 标题：{title}
- 类型：{type}
- 工作流：{workflow}
- Issue：#{issue_number} {issue_url}

产出文件：
- 任务文件：.agents/workspace/active/{task-id}/task.md

下一步 - 执行需求分析：
  - Claude Code / OpenCode：/analyze-task {task-ref}
  - Gemini CLI：/agent-infra:analyze-task {task-ref}
  - Codex CLI：$analyze-task {task-ref}
```

场景 B：未创建 Issue 时输出：
```
任务已创建。

任务信息：
- 任务 ID：{task-id}（短号 {task-ref}）
- 标题：{title}
- 类型：{type}
- 工作流：{workflow}

产出文件：
- 任务文件：.agents/workspace/active/{task-id}/task.md

下一步 - 执行需求分析：
  - Claude Code / OpenCode：/analyze-task {task-ref}
  - Gemini CLI：/agent-infra:analyze-task {task-ref}
  - Codex CLI：$analyze-task {task-ref}
```

场景 C：Issue 创建失败时输出：
```
任务已创建，但 Issue 级联创建失败。

任务信息：
- 任务 ID：{task-id}（短号 {task-ref}）
- 标题：{title}
- 类型：{type}
- 工作流：{workflow}

Issue 创建失败：
- 错误码：{error_code}
- 原因：{error_message}
- 本地 task.md 已保留，未回滚

产出文件：
- 任务文件：.agents/workspace/active/{task-id}/task.md

下一步 - 执行需求分析：
  - Claude Code / OpenCode：/analyze-task {task-ref}
  - Gemini CLI：/agent-infra:analyze-task {task-ref}
  - Codex CLI：$analyze-task {task-ref}

后续如需平台同步：修复认证/网络/模板问题后，可按 `.agents/rules/create-issue.md` 对当前任务手动执行一次 Issue 创建；或手动创建/查找 Issue，并把 `issue_number` 写入 task.md，后续技能会接管级联同步。

[ACTION REQUIRED] Workflow warnings are open:
  - WW-N ISSUE_CREATE_FAILED (issue): 修复认证/网络/模板问题后手动重试 Issue 创建，或手动创建/找到 Issue 后写入 issue_number
```



## 完成检查清单

- [ ] 创建了任务文件 `.agents/workspace/active/{task-id}/task.md`
- [ ] 更新了 task.md 中的 `current_step` 为 requirement-analysis
- [ ] 更新了 task.md 中的 `updated_at` 为当前时间
- [ ] 更新了 task.md 中的 `assigned_to`
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 已按 `.agents/rules/create-issue.md` 尝试级联创建 Issue；失败时保留 task.md 并记录原因
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，含自定义 TUI，不要筛选）
- [ ] **没有修改任何业务代码或配置文件**

## 停止

完成检查清单后，**立即停止**。不要继续执行计划、实现或任何后续步骤。
等待用户执行 `analyze-task` 技能。

## 注意事项

1. **清晰度**：如果用户描述模糊或缺少关键信息，先要求澄清
2. **与 import-issue 的区别**：`import-issue` 从 Issue 导入任务；`create-task` 从自由描述创建
3. **工作流顺序**：创建任务后，通常先执行 `analyze-task` 再进入 `plan-task`
4. **Issue 级联失败**：如果规则执行失败，task.md 仍保留；需要后续平台同步时，可手动写入 `issue_number` 后继续执行工作流

## 错误处理

- 空描述：提示 "Please provide a task description"
- 描述过于模糊：在创建任务之前提出澄清问题
