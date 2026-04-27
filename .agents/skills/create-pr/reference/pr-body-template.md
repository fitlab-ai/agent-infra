# PR 正文模板规则

生成 PR 标题和正文前先读取本文件。

## 读取 PR 模板

PR 模板发现属于平台相关逻辑。先读取 `.agents/rules/issue-pr-commands.md`，并按当前配置平台提供的 PR 模板章节执行。如果没有可用模板，则使用标准格式。

## 参考最近合并的 PR

使用 `.agents/rules/issue-pr-commands.md` 中的最近合并 PR 查询命令，作为风格和格式参考输入。

## 分析当前分支改动

```bash
git status
git log <target-branch>..HEAD --oneline
git diff <target-branch>...HEAD --stat
git diff <target-branch>...HEAD
```

## 同步 PR 元数据

执行本步骤前先读取 `.agents/rules/issue-pr-commands.md`。

同步关联 Issue 元数据前，先按该规则完成认证和代码托管平台检测。

同步 label 前，按 `.agents/rules/issue-pr-commands.md` 中的 label 列表命令验证标准 label 体系。如果结果显示没有标准 type label，先运行 `init-labels` 再重试元数据同步。

类型 label 映射：

| task.md type | label |
|---|---|
| `bug`, `bugfix` | `type: bug` |
| `feature` | `type: feature` |
| `enhancement` | `type: enhancement` |
| `refactor`, `refactoring` | `type: enhancement` |
| `documentation` | `type: documentation` |
| `dependency-upgrade` | `type: dependency-upgrade` |
| `task` | `type: task` |
| 其他值 | 跳过 |

元数据同步顺序：
1. 通过 `.agents/rules/issue-pr-commands.md` 的 Issue 读取命令查询 Issue labels 和 milestone
2. 从映射出的 type label、非 `type:` / 非 `status:` 的 Issue labels，以及当前 Issue `in:` labels 构建 `{label-args}`（commit 已经计算过，不在此重算，也不写回 Issue）
3. 按 `.agents/rules/milestone-inference.md` 的 "阶段 3：`create-pr`" 复用 Issue milestone 构建 `{milestone-arg}`
4. 按 `.agents/rules/issue-pr-commands.md` 的创建 PR 命令模板与权限降级规则，将 `{label-args}` 和 `{milestone-arg}` 原子化传入
5. 确保 PR 正文包含 `Closes #{issue-number}` 或等价关闭关键字

如果规则要求跳过上述直接元数据参数，则只保留 PR 正文关联和后续评论同步。

Milestone 规则：
- 按 `.agents/rules/milestone-inference.md` 的 "阶段 3：`create-pr`" 执行
- 直接复用关联 Issue 的 milestone，不为 PR 重新推断

## 创建 PR

- 当前工作属于 active task 时，从 task.md 提取 `issue_number`
- 如果存在 `issue_number`，先完成代码托管平台检测，再通过 `.agents/rules/issue-pr-commands.md` 查询 Issue
- 调用 PR 创建命令前，先检查当前分支是否已有 PR；若已有，报告 PR URL 和状态后停止，不重复执行元数据同步或 summary 发布
- 使用 HEREDOC 传入 PR 正文
- 模板中存在 `{$IssueNumber}` 时进行替换
- PR 正文以 `Generated with AI assistance` 结尾

使用 `.agents/rules/issue-pr-commands.md` 中的创建 PR 命令模板创建 PR。

最终用户输出应包含以下后续路径：

```text
Next steps:
  - complete the task after the workflow truly finishes:
    - Claude Code / OpenCode: /complete-task {task-id}
    - Gemini CLI: /agent-infra:complete-task {task-id}
    - Codex CLI: $complete-task {task-id}
```
