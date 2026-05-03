# Issue 创建

当 `create-task` 完成本地 `task.md` 落盘后，按本规则级联创建 Issue。本规则仅由 `create-task` SKILL.md 内部引用，不应独立调用。

## 行为边界

- Issue 标题和正文只能来自 `task.md`
- 不读取 `analysis.md`、`plan.md`、`implementation.md` 或审查产物
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

- 任务标题（首个 `# ` 标题，去掉 `任务：` / `Task:` 前缀）
- `## Description` / `## 描述` 段落
- `## Requirements` / `## 需求` 段落
- frontmatter 中的 `type` 与（可选的）`milestone`

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

Issue 模板检测：按 `.agents/rules/issue-pr-commands.md` 的 "Issue 模板检测" 规则扫描 `.github/ISSUE_TEMPLATE/*.yml`（排除 `config.yml`）。

#### 场景 A：检测到匹配模板

按模板顶层 `name` 与任务类型挑选最匹配的 form（如任务 `type: bugfix` 优先选名称含 `bug` 的模板）；找不到匹配时，回退到通用 form（如 `other.yml`），仍找不到时取目录中第一个 form。

按 `.agents/rules/issue-pr-commands.md` 中 "Issue 模板检测" 章节的字段处理规则填充 form：

- `textarea` / `input` 字段：使用 `attributes.label` 作为 markdown 标题，从 task.md 取值
- `markdown` 字段：跳过（说明文案）
- `dropdown` / `checkboxes` 字段：跳过

字段值映射（建议）：

| 模板字段提示 | task.md 来源 |
|---|---|
| `summary`, `title` | 任务标题 |
| `description`, `problem`, `what happened`, `issue-description`, `current-content` | 任务描述 |
| `solution`, `requirements`, `steps`, `suggested-content`, `impact`, `context`, `alternatives`, `expected` | 需求列表（已勾选与未勾选混合，原样保留） |
| 其它 `textarea` / `input` 字段 | 任务描述；缺失时填 `N/A` |

任何字段在 task.md 中找不到合适值时，写入 `N/A`。

#### 场景 B：无模板或解析失败

回退到默认正文：

```markdown
## Description

{任务描述；缺失时填 N/A}

## Requirements

- [ ] {requirement-1}
- [ ] {requirement-2}
```

需求列表为空时，整段写 `N/A`。

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

实际设置时按 `.agents/rules/issue-pr-commands.md` 的 "设置 Issue Type" 命令；先调 `gh api orgs/{owner}/issue-types` 列出 org 实际可用的 Type，仅当推断值在列表中时才设置；设置失败不阻断流程。

#### milestone

按 `.agents/rules/milestone-inference.md` 的 "阶段 1：`create-task`（平台规则创建 Issue 时）" 规则推断；推断结果为空或仓库无对应 milestone 时省略。

### 5. 调用 GitHub CLI 创建 Issue

按 `.agents/rules/issue-pr-commands.md` 中的 "创建 Issue" 命令执行：

```bash
gh issue create -R "$upstream_repo" \
  --title "{title}" \
  --body "{body}" \
  --assignee @me \
  {label-args} \
  {milestone-arg}
```

- `{label-args}` 由 §4 计算结果展开为多个 `--label "..."`；为空则整体省略
- `{milestone-arg}` 仅当 `has_triage=true` 且 milestone 非空时展开为 `--milestone "..."`；否则整体省略
- `--assignee @me` 不做权限预判，失败时静默跳过

权限降级规则按 `.agents/rules/issue-sync.md`：`has_triage=false` 时跳过 label / milestone 设置；`has_push=false` 时跳过 Issue Type 设置；其余流程继续。

创建成功后从输出中解析 Issue 编号（仅匹配 `https://.../issues/(\d+)` URL 形式，不要使用宽松正则）；解析失败时停止级联并把错误传回 `create-task`。

### 6. 设置 Issue Type（可选）

仅当 `has_push=true` 且 §4 推断的 Issue Type 在 org 实际可用列表中时执行：

```bash
gh api "repos/$upstream_repo/issues/{issue-number}" -X PATCH \
  -f type="{issue-type}" --silent
```

设置失败不阻断流程。

### 7. 回写 task.md

更新 task.md：

- 把 `issue_number: {n}` 写入 frontmatter（已存在则替换；不存在则在 frontmatter 末尾追加）
- 更新 `updated_at` 为当前时间（命令：`date "+%Y-%m-%d %H:%M:%S%:z"`）
- 在 `## 活动日志` / `## Activity Log` 段落追加：
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Create Issue** by {agent} — Created GitHub Issue #{n}
  ```

### 8. 返回结果

把以下信息回传给调用方 `create-task`：

- Issue 编号 `{n}`
- Issue URL（首选 `gh issue create` 输出中的 URL；缺失时拼 `https://github.com/$upstream_repo/issues/{n}`）
- 实际应用的 labels / milestone / Issue Type

`create-task` 据此选择"场景 A：已创建 Issue"输出分支并继续执行后续 task 评论同步与 status label 设置。

## 错误处理

- 认证失败 / 命令不可用：返回结构化错误 `{code: "AUTH_FAILED", message}` 给 `create-task`，不修改 task.md
- 网络超时 / DNS 失败：`{code: "NETWORK", message}`
- 模板解析失败、Issue 编号解析失败、其它异常：`{code: "VALIDATION", message}`
- 任意失败均不回滚 task.md；`create-task` 走"场景 C 失败兜底"输出，提示用户手动重试或在事后写入 `issue_number`
