---
name: create-issue
description: >
  从任务文件创建 GitHub Issue。
  当用户要求为任务创建 Issue 时触发。参数：task-id。
---

# 创建 Issue

## 行为边界 / 关键规则

- 本技能的唯一产出是 GitHub Issue，以及 task.md 中 `issue_number` 字段的回写
- 构建 Issue 标题和正文时，**仅从 task.md 读取**；不要读取 `analysis.md`、`plan.md`、`implementation.md` 或其他产物
- 如果项目存在 Issue 模板，模板只提供正文结构、字段标题、默认 labels 和候选 Issue Type；所有实际正文内容值仍然只来自 task.md
- 不要在此技能中同步分析、方案、实现或审查细节；这些由 `sync-issue` 负责
- 执行本技能后，你**必须**立即更新 task.md 中的任务状态

## 执行步骤

### 1. 验证前置条件

检查必要文件：
- `.agent-workspace/active/{task-id}/task.md` - 任务文件

检查 GitHub CLI 可用且已认证：

```bash
gh auth status
```

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果任务文件不存在，提示 `Task {task-id} not found`。

如果 `task.md` front matter 中已经存在 `issue_number` 字段，且其值不为空也不为 `N/A`，先询问用户是复用现有 Issue 还是重新创建。

### 2. 提取任务信息

仅从 `task.md` 提取：
- 任务标题
- `## 描述` 内容
- `## 需求` 列表
- `type` 字段
- `milestone` 字段（如存在）

如果描述为空，提示用户先完善任务描述。

### 3. 构建 Issue 内容

Issue 内容规则：
- **标题**：使用任务标题
- **正文内容值**：仅来自 task.md
- **模板作用**：Issue 模板只提供结构、字段标签和默认 labels
- **Issue Type**：优先使用模板中的 `type:`；无模板时根据 task.md `type` 做 fallback 映射
- **无可用模板时**：退回简单格式（fallback / 兜底）

#### 3a. 检测 Issue 模板

检查项目中的模板文件，忽略 `config.yml`：

```bash
rg --files .github/ISSUE_TEMPLATE -g '*.yml' -g '!config.yml'
```

如果存在模板文件，读取每个模板的顶层 `name:` 字段，构建候选列表。结合任务标题和描述，从候选列表中选择最匹配的模板。

示例候选列表：
- `01_bug_report.yml` — 🐛 问题报告 / Bug Report
- `02_question.yml` — ❓ 问题咨询 / Question
- `03_feature_request.yml` — ✨ 功能请求 / Feature Request
- `04_documentation.yml` — 📚 文档问题 / Documentation Issue
- `05_other.yml` — 🔧 其他问题 / Other Issues

如果没有明确匹配的模板，选择最接近的一个。

如果没有模板、没有匹配到合适模板，或模板 YAML 解析失败，则直接进入 **3c fallback / 兜底路径**。

#### 3b. 使用模板构建 Issue 正文

读取匹配模板中的顶层字段：
- `name`
- `type:`
- `labels:`
- `body:`

模板路径的处理规则：
- 如果模板定义了 `type:`，记录为 `{issue-type}`
- `labels:` 中的每个值都视为候选 label
- 遍历 `body:` 列表
- 对 `type: textarea` 和 `type: input` 字段：
  - 使用 `attributes.label` 作为 markdown 段落标题
  - 将 task.md 信息映射到该段内容
- 对 `type: markdown`：跳过，不要把模板说明文本直接复制到正文
- 对 `type: dropdown` 和 `type: checkboxes`：跳过
- 如果 task.md 中没有合适内容，写入 `N/A`

字段映射建议：
- 包含 `summary`、`title` 的字段 -> 使用任务标题
- 包含 `description`、`problem`、`what happened`、`issue-description`、`current-content` 的字段 -> 使用任务描述
- 包含 `solution`、`requirements`、`steps`、`suggested-content`、`impact`、`context`、`alternatives`、`expected` 的字段 -> 使用需求列表（可渲染为 checklist 或 bullet list）
- 其他 `textarea` / `input` 字段 -> 优先使用任务描述，否则使用 `N/A`

对模板路径中的每个候选 label，都先检查是否存在：

```bash
gh label list --search "{label}" --limit 20 --json name --jq '.[].name'
```

只有精确匹配的 label 才保留用于创建 Issue。

#### 3c. 默认正文格式（fallback / 兜底）

推荐正文结构：

```markdown
## Description

{task-description}

## Requirements

- [ ] {requirement-1}
- [ ] {requirement-2}
```

标签映射：

| task.md type | GitHub label |
|---|---|
| `bug`、`bugfix` | `type: bug` |
| `feature` | `type: feature` |
| `enhancement` | `type: enhancement` |
| `docs`、`documentation` | `type: documentation` |
| `dependency-upgrade` | `type: dependency-upgrade` |
| `task`、`chore`、`refactor`、`refactoring` | `type: task` |
| 其他 | 跳过 |

Issue Type fallback 映射：

| task.md type | GitHub Issue Type |
|---|---|
| `bug`、`bugfix` | `Bug` |
| `feature`、`enhancement` | `Feature` |
| `task`、`documentation`、`dependency-upgrade`、`chore`、`docs`、`refactor`、`refactoring` 及其他值 | `Task` |

如果 fallback 路径映射到了 label，先检查该 label 是否存在：

```bash
gh label list --search "{type-label}" --limit 20 --json name --jq '.[].name'
```

只有存在精确匹配的 label 时，才在创建 Issue 时保留它；否则跳过 label，避免创建失败。

### 4. 创建 Issue

执行：

```bash
gh issue create --title "{title}" --body "{body}" --label "{label-1}" --label "{label-2}" --milestone "{milestone}"
```

如果前一步没有保留下任何有效 label，则省略所有 `--label` 参数。
如果 task.md 中没有 `milestone` 字段或值为空，默认使用 `General Backlog` 作为里程碑（新建 Issue 处于未分配状态，应归入通用积压）。如果 `General Backlog` 也不存在，则省略 `--milestone` 参数。

不要依赖 `gh issue create --template`；本技能应直接解析 `.github/ISSUE_TEMPLATE/*.yml` 并生成最终 `--body`。

记录命令输出的 Issue URL，并从末尾路径提取 Issue 编号：

```bash
issue_url="$(gh issue create ...)"
issue_number="${issue_url##*/}"
```

如果已经确定了 `{issue-type}`，在创建后以 best-effort 方式设置 Issue Type：

获取仓库信息（后续 `in:` label 步骤也会复用）：

```bash
repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
owner="${repo%%/*}"
```

查询组织可用的 Issue Types：

```bash
gh api "orgs/$owner/issue-types" --jq '.[].name'
```

如果查询成功且 `{issue-type}` 在返回列表中，执行设置：

```bash
gh api "repos/$repo/issues/{issue-number}" -X PATCH -f type="{issue-type}" --silent
```

验证设置结果：

```bash
gh api "repos/$repo/issues/{issue-number}" --jq '.type.name // empty'
```

如果验证返回的名称与 `{issue-type}` 一致，记录 `Issue Type: {issue-type}`；否则记录 `Issue Type: failed to set`。

#### 添加 `in:` labels

获取仓库中所有 `in:` 前缀的 labels：

```bash
gh label list --search "in:" --limit 50 --json name --jq '.[].name'
```

如果没有 `in:` labels，跳过此步骤。

如果存在 `in:` labels，结合任务上下文（标题、描述、受影响文件列表）判断每个 `in:` label 是否与当前任务相关。对判断为相关的 label，执行：

```bash
gh issue edit {issue-number} --add-label "in: {module}"
```

记录所有成功添加的 `in:` labels。如果没有判断为相关的 label，记录 `in: labels: skipped (no relevant labels)`。

容错要求：
- 如果 `orgs/$owner/issue-types` 返回 `404`、仓库 owner 不是组织，或仓库未启用 Issue Types，则跳过，不要让创建失败
- 如果目标 `{issue-type}` 不在可用列表中，则跳过
- `in:` label 添加失败时，跳过并记录，不阻止 Issue 创建流程
- Milestone 不存在或名称无效时，也应提示并跳过，而不是中断整个 Issue 创建流程

### 5. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 `.agent-workspace/active/{task-id}/task.md`：
- 添加或更新 `issue_number`：`{issue-number}`
- `updated_at`：{当前时间}
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Create Issue** by {agent} — Issue #{issue-number} created
  ```

### 6. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

输出格式：
```
任务 {task-id} 的 Issue 已创建。

Issue 信息：
- 编号：#{issue-number}
- URL：{issue-url}
- Labels：{applied-labels 或 skipped}
- in: Labels：{applied-in-labels 或 skipped}
- Issue Type：{issue-type | failed to set | skipped}
- Milestone：{milestone 或 skipped}

产出：
- task.md 已回写 `issue_number`

下一步 - 同步任务进度到 Issue：
  - Claude Code / OpenCode：/sync-issue {task-id}
  - Gemini CLI：/agent-infra:sync-issue {task-id}
  - Codex CLI：$sync-issue {task-id}
```

## 完成检查清单

- [ ] 创建了 GitHub Issue
- [ ] 检测了项目 `ISSUE_TEMPLATE`
- [ ] 有模板时按模板结构生成正文；无模板时走 fallback / 兜底格式
- [ ] Issue 标题和正文仅来自 task.md
- [ ] 如可用，处理了 `type:` / Issue Type 和 `milestone`
- [ ] 处理了 `in:` labels（LLM 判断关联性）
- [ ] 在 task.md 中记录了 `issue_number`
- [ ] 更新了 task.md 中的 `updated_at`
- [ ] 追加了 Activity Log 条目到 task.md
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，不要筛选）
- [ ] **没有读取分析/方案/实现产物来构建 Issue**

## 停止

完成检查清单后，**立即停止**。不要继续同步 Issue 内容或执行后续工作流步骤。

## 注意事项

1. **职责边界**：`create-issue` 只负责创建基础 Issue；详细上下文同步由 `sync-issue` 负责
2. **避免重复创建**：已有 `issue_number` 时，先与用户确认
3. **Label 容错**：标准 label 未初始化时，可以跳过 label，但不要阻止 Issue 创建
4. **模板容错**：模板缺失、匹配失败或 YAML 异常时，退回 fallback / 兜底正文，不要让整个创建失败
5. **Issue Type / Milestone 容错**：Issue Type 未启用、类型不存在或 milestone 不可用时，跳过该项并继续创建
6. **in: Label 容错**：`in:` label 添加失败时跳过，不阻止 Issue 创建

## 错误处理

- 任务未找到：提示 `Task {task-id} not found`
- 未安装或未认证 `gh`：提示 `GitHub CLI is not available or not authenticated`
- 描述为空：提示 `Task description is empty, please update task.md first`
- 创建失败：提示 `Failed to create GitHub Issue`
