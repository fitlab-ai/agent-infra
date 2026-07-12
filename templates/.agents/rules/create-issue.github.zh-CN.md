# Issue 创建

当 `create-task` 完成本地 `task.md` 落盘后，按本规则级联创建 Issue。本规则仅由 `create-task` SKILL.md 内部引用，不应独立调用。

## 行为边界

- Issue 标题和正文只能来自 `task.md`
- 不读取 `analysis.md`、`review-analysis.md`、`plan.md`、`review-plan.md`、`code.md` 或代码审查产物
- 持久产物只有：远端 Issue + `task.md` 中回写的 `issue_number`
- Issue 创建失败时不回滚 `task.md`；当前 task 仍可继续后续工作流，未来可由用户手动写入 `issue_number`，让其它技能的级联同步接管

## 执行步骤

### 1. 验证前置条件

- `.agents/workspace/active/{task-id}/task.md` 必须存在
- 先读取 `.agents/rules/issue-pr-commands.md`，按其中的认证与平台检测命令验证 `gh auth status` 和当前仓库可用
- 先读取 `.agents/rules/issue-sync.md`，完成 `upstream_repo`、`has_triage`、`has_push` 检测；后续所有 `gh issue` 与 repo 级 `gh api` 调用都复用这些变量
- 如果 `task.md` 中 `issue_number` 已存在且既不为空也不为 `N/A`，立即停止级联：返回"任务已绑定 Issue #{n}，跳过创建"信息给 `create-task`，由调用方决定如何继续

### 2. 提取任务信息

从 `task.md` 提取以下字段：

- 任务标题（首个 `# ` 标题，去掉 `任务：` / `Task:` 前缀）—— 用于构造 Issue 标题
- frontmatter 中的 `type` 与（可选的）`milestone`

> Issue **正文**不在此处手工提取。正文由 §3 调用 `ai task issue-body` 命令从 `## 描述` / `## 需求` 段确定性生成，调用方不得自行拼装。

构造 Issue 标题：

| task.md `type` | Conventional Commits type |
|---|---|
| `feature` | `feat` |
| `bugfix`, `bug` | `fix` |
| `refactor`, `refactoring` | `refactor` |
| `docs`, `documentation` | `docs` |
| `chore`, `task` 或其它 | `chore` |

scope 推断：从 `.agents/.airc.json` 的 `labels.in` 字段读取已知模块名，再与任务标题/描述做语义匹配；没有清晰命中时省略 scope。最终标题：`{cc_type}({scope}): {task_title}` 或 `{cc_type}: {task_title}`（任务标题保留原文，不要翻译或改写）。

### 3. 构建 Issue 正文

> **机械化边界（必须遵守）**：Issue 正文一律由 `ai task issue-body` 命令确定性生成；调用方只把命令 stdout 作为 `gh issue create` 的 `--body-file` 传入，**不得**自行拼装、改写或截断正文。命令只输出 task 标题 / `## 描述` / `## 需求` 对应内容，task.md 其余脚手架段落永不进入 body。

Issue 模板检测：按 `.agents/rules/issue-pr-commands.md` 的 "Issue 模板检测" 规则扫描 `.github/ISSUE_TEMPLATE/*.yml`（排除 `config.yml`）。

#### 场景 A：检测到匹配模板

按模板顶层 `name` 与任务类型挑选最匹配的 form（如任务 `type: bugfix` 优先选名称含 `bug` 的模板）；找不到匹配时，回退到通用 form（如 `other.yml`），仍找不到时取目录中第一个 form。

确定模板文件 `{form-path}` 后，由命令按该 Issue Form 渲染最终正文，并写入正文文件 `{body-file}` 供 §5 使用：

```bash
ai task issue-body {task-id} --template "{form-path}" > "{body-file}"
```

命令跳过 `markdown` / `dropdown` / `checkboxes` 字段，对 `input` / `textarea` 字段以 `attributes.label` 作标题、按字段 `id` 确定性填入 task 标题 / 描述 / 需求，无可靠映射源的字段填 `N/A`（字段映射表是命令内的单一真源，不在本规则重述）。命令退出码非 0（文件缺失 / 非法 YAML / 无 `body`）时，改用场景 B 命令重新生成 `{body-file}`。

#### 场景 B：无模板或解析失败

由命令输出默认正文（仅 `## 描述` + `## 需求`，复选框逐字保留，缺失段落填 `N/A`），写入 `{body-file}`：

```bash
ai task issue-body {task-id} > "{body-file}"
```

#### 红线：禁止把整份 task.md 当 body

无论场景 A / B，body 只能来自 `ai task issue-body` 的 stdout，**只含 描述 + 需求两段内容**（场景 A 为按模板字段映射后的等价内容）。

错误示范（❌ 禁止）：把含 `## 分析` / `## 设计` / `## 实现备注` / `## 审查反馈` / `## 审查分歧账本` / `## 人工裁决` / `## 活动日志` / `## 完成检查清单` 等脚手架段落、以及 `#XXX` 占位的整份 task.md 直接作为 Issue body。这些段落只走 `sync-issue:{task-id}:task` 评论，绝不进 body。

### 4. 解析 labels / Issue Type / milestone

#### labels（粗选）

- 调用 `gh api "repos/$upstream_repo/labels?per_page=100" --jq '.[].name'` 获取仓库实际存在的 label 列表（缓存为 set）
- 按以下映射挑出"应有的 type label"，仅保留仓库 set 中实际存在的：

  | task.md `type` | label |
  |---|---|
  | `bug`, `bugfix` | `type: bug` |
  | `feature` | `type: feature` |
  | `enhancement` | `type: enhancement` |
  | `docs`, `documentation` | `type: documentation` |
  | `dependency-upgrade` | `type: dependency-upgrade` |
  | `task`, `chore` | `type: task` |
  | `refactor`, `refactoring` | `type: enhancement` |
  | 其它 | 跳过 |

- `in:` label（粗选，宁缺毋滥）：根据任务标题与描述对 `labels.in` 中的模块名做语义匹配；明确提及或强烈暗示 → 添加 `in: {module}`；模糊或不确定 → 不添加。`in:` label 同样要求仓库实际存在。

最终 label 集合若为空，省略 `--label` 参数。

#### Issue Type fallback

| task.md `type` | Issue Type |
|---|---|
| `bug`, `bugfix` | `Bug` |
| `feature`, `enhancement` | `Feature` |
| `task`, `documentation`, `dependency-upgrade`, `chore`, `docs`, `refactor`, `refactoring` 及其它 | `Task` |

实际设置时按 `.agents/rules/issue-pr-commands.md` 的 "设置 Issue Type" 命令；仅当 owner type 为 `Organization` 时，先调 `gh api orgs/{owner}/issue-types` 列出 org 实际可用的 Type，并且仅当推断值在列表中时才设置；个人仓库、owner type 探测失败或设置失败都不阻断流程。

#### milestone

**必须执行，不得跳过**。本节是 `.agents/rules/milestone-inference.md` 阶段 1 的就地展开，语义与之对齐；不要把它当成"可选推断"。

按以下编号步骤选取 milestone（优先级与阶段 1 严格一致）：

1. 如果 `has_triage=false`：直接省略 `--milestone`，跳过本节。
2. 列出仓库 open 状态的全部 milestone：
   ```bash
   gh api "repos/$upstream_repo/milestones?state=open&per_page=100" \
     --jq '.[].title'
   ```
3. 如果 `task.md` frontmatter 显式给出 `milestone` 字段，且该值出现在步骤 2 列表中：直接使用该值作为 `{milestone-arg}`，跳过步骤 4 / 5。
4. 用正则 `^[0-9]+\.[0-9]+\.x$` 过滤步骤 2 结果。
   - 非空：按 major、minor 数值升序排序，取最小的版本线作为 `{milestone-arg}`。
5. 步骤 4 候选为空：尝试回退到 `General Backlog`。
   - 步骤 2 结果中存在 `General Backlog`：使用该 milestone。
   - 不存在 `General Backlog`：仅在此情况下省略 `--milestone`。
6. 步骤 2 的 `gh api` 调用失败（网络 / 认证错误）：按"无候选"处理，落到步骤 5。

设置成功时把版本线（或 `General Backlog` 或 task.md 显式值）作为 `{milestone-arg}` 带入步骤 5 的 `gh issue create` 命令；§5 末尾的展开规则保持不变。

### 5. 调用 GitHub CLI 创建 Issue

按 `.agents/rules/issue-pr-commands.md` 中的 "创建 Issue" 命令执行；正文统一用 §3 生成的 `{body-file}`，覆盖通用命令的 `--body`：

```bash
gh issue create -R "$upstream_repo" \
  --title "{title}" \
  --body-file "{body-file}" \
  --assignee @me \
  {label-args} \
  {milestone-arg}
```

- `{body-file}` 为 §3 由 `ai task issue-body` 生成的正文文件；**不得**改用 `--body` 自行拼装正文
- `{label-args}` 由 §4 计算结果展开为多个 `--label "..."`；为空则整体省略
- `{milestone-arg}` 仅当 `has_triage=true` 且 milestone 非空时展开为 `--milestone "..."`；否则整体省略
- `--assignee @me` 不做权限预判，失败时静默跳过

权限降级规则按 `.agents/rules/issue-sync.md`：`has_triage=false` 时跳过 label / milestone 设置；`has_push=false` 时跳过 Issue Type 设置；其余流程继续。

创建成功后从输出中解析 Issue 编号（仅匹配 `https://.../issues/(\d+)` URL 形式，不要使用宽松正则）；解析失败时停止级联并把错误传回 `create-task`。

### 6. 设置 Issue Type（可选）

仅当 `has_push=true`、owner type 为 `Organization`，且 §4 推断的 Issue Type 在 org 实际可用列表中时执行：

```bash
gh api "repos/$upstream_repo/issues/{issue-number}" -X PATCH \
  -f type="{issue-type}" --silent
```

设置失败不阻断流程。

### 7. 设置 Issue 字段（可选）

如果 `has_push=true`，读取 `.agents/rules/issue-fields.md`，按流程 A 写入 `task.md` 中适用且非空的 `priority`、`effort`、`start_date` 和 `target_date`。

字段写入失败不阻断流程。

### 8. 回写 task.md

更新 task.md：

- 把 `issue_number: {n}` 写入 frontmatter（已存在则替换；不存在则在 frontmatter 末尾追加）
- 更新 `updated_at` 为当前时间（命令：`date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'`）

> 不要在此追加 Activity Log 条目。Issue 创建事件已由 GitHub Issue 自身和 frontmatter `issue_number` 承载；Activity Log 仅记录 `create-task` skill 一次执行的整体锚点（`Create Task`），由调用方 SKILL 步骤 3 写入。

### 9. 返回结果

把以下信息回传给调用方 `create-task`：

- Issue 编号 `{n}`
- Issue URL（首选 `gh issue create` 输出中的 URL；缺失时拼 `https://github.com/$upstream_repo/issues/{n}`）
- 实际应用的 labels / milestone / Issue Type

`create-task` 据此选择"场景 A：已创建 Issue"输出分支并继续执行后续 task 评论同步与 status label 设置。

## 错误处理

- 认证失败 / 命令不可用：返回结构化错误 `{code: "AUTH_FAILED", message}` 给 `create-task`，不修改 task.md
- 网络超时 / DNS 失败：`{code: "NETWORK", message}`
- 模板解析失败、Issue 编号解析失败、其它异常：`{code: "VALIDATION", message}`
- 任意失败均不回滚 task.md；`create-task` 必须把结构化错误写入 `## 工作流告警`（`severity=ACTION_REQUIRED`，`code=ISSUE_CREATE_FAILED`，`target=issue`），再走"场景 C 失败兜底"输出，提示用户手动重试或在事后写入 `issue_number`
