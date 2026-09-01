---
name: create-task
description: >
  根据自然语言描述创建任务。
  当想把一段自然语言的想法或需求落为受跟踪的任务时使用。
---

# 创建任务
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」。


## 行为边界 / 关键规则

**本技能的核心产出是 `task.md`。**

- 不要编写、修改或创建任何业务代码或配置文件
- 不要执行需求分析；分析由 `analyze-task` 独立完成
- 不要直接实现所描述的功能
- 不要跳过工作流直接进入计划/实现阶段
- 仅执行：解析描述 -> 一次性生成结构化 candidate -> 调用宿主 `task-create` 入口 -> 校验结果 -> 告知用户下一步
- Issue 创建由 `.agents/rules/create-issue.md` 规则决定；自定义或空平台（未提供平台变体规则文件）时，规则会自然降级为 no-op

用户的描述是一个**待办事项**，而不是**立即执行的指令**。

执行本技能后，你**必须**立即更新 task.md 中的任务状态。

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：记录开始时间

本技能会**创建** task.md，开始时尚无文件可写。先在内存记录开始时间 `started_at`（`date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'`）；在最后写活动日志时**一次性补两条**——started 行用 `started_at`、done 行用完成时间，二者同基名（started 行 action 加 ` [started]` 后缀、note 用 `started`）：

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

执行本步骤前，先读取 `reference/context-capture.md`。把当前请求及必要前序讨论中已有的信息按来源与状态分类，准备写入 task.md 的 `## 任务输入`；缺失类别保持为空，不执行推导或分析。

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

### 2. 生成不可变 candidate

获取当前时间戳：

```bash
date +%Y%m%d-%H%M%S
```

- 生成随机 UUID v4 作为 `idempotencyKey`，并把步骤 1 的结果写入单个 JSON 文件。
- candidate 必须符合宿主 `TaskCreateCandidateV1`：`version`、`idempotencyKey`、标准 `agent`、`title`、`type`、不带项目前缀的 `branchSlug`、`priority`、`effort`、`description` 和 `taskInput` 七类列表。
- 受控 candidate 的 `title`、`description` 和 `taskInput` 七类列表项必须在生成时就是安全的 Markdown：明确的非用户语义 token（例如 `@2x`）直接输出为代码格式（`` `@2x` ``）；邮箱、真实用户 mention 和 URL 等具有明确语义的 `@` 保持原样。该约束只适用于本技能生成的 candidate，不改写手写或外部内容。
- 首次提交前只写一次 candidate；等待终态期间不得重新运行 AI 推导或改写文件。超时重试必须复用同一文件，由客户端生成新的 outer request ID。

调用统一入口：

```bash
agent-infra-internal task-create --input "$candidate_file"
```

宿主负责 TASK-id/时间戳/版本戳、workflow/branch 派生、模板渲染、原子持久化、短号、Issue 与 warning。技能不得自行 `mkdir`、复制任务模板、分配短号或直接调用平台子命令。

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

### 3. 处理结构化结果

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
```

- `applied` / `no-op`：从响应读取 task ID、短号与可选 Issue 身份；不得从目录扫描推断。
- `degraded`：本地任务已经保留；展示响应中的 warning。
- `blocked`：保留 candidate 文件，修复暂态问题后用同一文件重试。
- `failed`：报告稳定错误码；幂等冲突时不得改写原 key 或原 candidate 后重试。

### 4. 平台失败兼容说明

平台级联由宿主服务完成。兼容的人工恢复命令仍由宿主 warning 指引，不在沙箱内执行：

```bash
agent-infra-internal task-warning {task-id} add --step create-task --severity ACTION_REQUIRED --code ISSUE_CREATE_FAILED --target issue --message "{error_code}: {error_message}" --action "修复认证/网络/模板问题后手动重试 Issue 创建，或手动创建/找到 Issue 后写入 issue_number"
agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}
```

技能只消费宿主返回的 Issue identity、operations 与 warnings；不得重复发起平台写入。

### 5. 完成校验

宿主 `task-create` 服务在返回前运行同一 typed 完成校验；技能从响应的 `task:verify` operation 取得当次结果。branch-only 不得尝试读取不可见的新任务。宿主直接诊断时可运行：

```bash
agent-infra-internal task-verify {task-id} create-task.completed --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 6. 告知用户

> 仅在校验通过后执行本步骤。

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

场景 A：已创建 Issue 时输出：
使用 `agent-infra-internal agent-client next-steps --skill analyze-task --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

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
{next-step-commands}
```

场景 B：未创建 Issue 时输出：
使用 `agent-infra-internal agent-client next-steps --skill analyze-task --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

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
{next-step-commands}
```

场景 C：Issue 创建失败时输出：
使用 `agent-infra-internal agent-client next-steps --skill analyze-task --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

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
{next-step-commands}

后续如需平台同步：修复认证/网络/模板问题后，可按 `.agents/rules/create-issue.md` 对当前任务手动执行一次 Issue 创建；或手动创建/查找 Issue，并把 `issue_number` 写入 task.md，后续技能会接管级联同步。

[ACTION REQUIRED] Workflow warnings are open:
  - WW-N ISSUE_CREATE_FAILED (issue): 修复认证/网络/模板问题后手动重试 Issue 创建，或手动创建/找到 Issue 后写入 issue_number
```



## 完成检查清单

- [ ] 只生成一次结构化 candidate 并调用 `agent-infra-internal task-create`
- [ ] 宿主创建了任务文件 `.agents/workspace/active/{task-id}/task.md`
- [ ] 已按 `reference/context-capture.md` 写入并复核 `## 任务输入` 的来源与状态语义
- [ ] 响应中的任务 ID 和短号已通过完成校验
- [ ] 已按 `.agents/rules/create-issue.md` 尝试级联创建 Issue；失败时保留 task.md 并记录原因
- [ ] 已通过统一 helper 渲染已选场景的下一步命令
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
