---
name: create-pr
description: >
  创建 Pull Request 到目标分支。
  当变更已提交、需要发起 Pull Request 评审时使用。
---

# 创建 Pull Request

创建 Pull Request，并在与任务关联时立即补齐核心元数据和 reviewer 摘要。

## 行为边界 / 关键规则

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 任务上下文解析

> 入口允许省略 task ref，也接受旧位置 task ref 或 `--task <ref>` / `-t <ref>`。先从完整参数中分离 task scope 并原样保留其他业务操作数，再调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空、位置 ref 或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为该完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

## 步骤开始：started 标记

真实执行 `platform-pr create` 时由 typed core 在远端写入前幂等登记 `Create PR [started]`；dry-run 不登记。调用方不得重复手写该条目。

## 执行流程

### 前置门控：项目级 PR 流程检查

**门控读取（项目级 PR 流程策略）**：在执行编号步骤前，读取 `.agents/.airc.json` 的 `prFlow` 字段（三态：字段缺省 = 默认推荐 PR、允许跳过；`"required"` = 强制 PR；`"disabled"` = 强制无 PR）。

按读取结果分支：
- 缺省 / `"required"` → 继续到下方第 1 步
- `"disabled"` → 输出以下消息后**立即停止**，不要执行任何后续编号步骤、不要触发任何 PR 创建命令、不要修改 `task.md` 的 `pr_number` / `pr_status`、不要发布 PR 摘要评论：

```
当前项目未启用 PR 流程（`.agents/.airc.json` 中 `prFlow: "disabled"`）。
无需创建 Pull Request，请直接运行：
  - Claude Code / OpenCode：/complete-task {task-ref}
  - Gemini CLI：/agent-infra:complete-task {task-ref}
  - Codex CLI：$complete-task {task-ref}
```

### 1. 解析命令参数

从命令参数中识别：
- 匹配 `TASK-{yyyyMMdd-HHmmss}` 格式的参数 -> `{task-id}`
- 其余参数 -> `{target-branch}`

如果提供了 `{task-id}`，读取 `.agents/workspace/active/{task-id}/task.md` 获取任务信息（例如 `issue_number`、`type` 等）。
如果未提供，可从当前 session 上下文获取；仍无法确定 `{task-id}` 时，后续步骤中的任务关联逻辑跳过。

### 2. 确定目标分支

如果用户显式提供参数就直接使用；否则根据 Git 历史和分支拓扑自动推断。

> 详细分支判断规则见 `reference/branch-strategy.md`。自动推断 base 分支前，先读取 `reference/branch-strategy.md`。

### 3. 准备 PR 正文

通过 `.agents/rules/issue-pr-commands.md` 读取 PR 模板，参考最近合并的 PR 风格，并收集 `<target-branch>` 到 `HEAD` 的全部提交。

> 模板处理、HEREDOC 正文生成和 `Generated with AI assistance` 要求见 `reference/pr-body-template.md`。编写正文前先读取 `reference/pr-body-template.md`。

### 4. 检查远程分支状态

确认当前分支是否已有 upstream；必要时执行 `git push -u origin <current-branch>`。

### 5. 创建或恢复 PR

执行前先读取 `.agents/rules/issue-pr-commands.md`，把标题和正文写入临时文件，并调用其中的 `platform-pr create` intent。core 先按 head/base 精确定位：唯一既有 PR 会复用并绑定，零个才创建，多个稳定失败；重放不得产生重复 PR。

如果获取到 `{task-id}` 且对应任务提供了 `issue_number`，必须在 PR 正文中保留 `Closes #{issue-number}`。

### 6. 同步 PR 元数据

调用 `agent-infra-internal platform-pr sync {task-id} --agent {agent} --metadata --closing-issue`。core 从 Issue 复制 type / `in:` labels、assignee 和具体 milestone，并维护 Development 关联；逐项权限不足返回 degraded，不反向更新 Issue。

### 7. 发布审查摘要

读取最新的上下文产物：`plan.md` / `plan-r{N}.md`、`review-plan.md` / `review-plan-r{N}.md`、`code.md` / `code-r{N}.md`、`review-code.md` / `review-code-r{N}.md`（存在时）。

基于这些产物聚合 reviewer 摘要，并使用隐藏标记维护唯一且幂等的摘要评论。

> canonical context、摘要聚合和 `summary-sync` 调用见 `reference/comment-publish.md`（其引用 `.agents/rules/pr-sync.md`）。发布摘要前先读取该 reference。

### 8. 确认任务状态

`platform-pr create` 在成功创建或恢复唯一远端身份后，通过任务写入内核原子更新 `pr_number`、`pr_status`、规范时间/版本和 Create PR 完成日志。调用方只核对结构化结果，不再次编辑这些字段。

### 9. 完成校验

如果本次操作关联了 `{task-id}`，运行完成校验，确认任务元数据和同步状态符合规范；如果没有任务上下文，跳过本步骤。

```bash
agent-infra-internal task-verify {task-id} create-pr.completed --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 10. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。 渲染最终输出前，先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令把 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

说明 PR URL、元数据同步结果、摘要评论结果，并推荐下一步进入 PR 监控（按 `.agents/rules/next-step-output.md` 把 `{task-ref}` 渲染为短号 `#NN`）：

```
下一步 - 监控 PR 检查（required checks 全绿前自动自愈）：
  - Claude Code / OpenCode：/watch-pr {task-ref}
  - Gemini CLI：/agent-infra:watch-pr {task-ref}
  - Codex CLI：$watch-pr {task-ref}
```

或者，若想跳过主动监控并立即尝试完成，改用 `complete-task`；其 required-checks 硬门禁仍会对 pending/failed/head mismatch fail-closed：

```
下一步（备选）- 跳过主动监控并尝试完成：
  - Claude Code / OpenCode：/complete-task {task-ref}
  - Gemini CLI：/agent-infra:complete-task {task-ref}
  - Codex CLI：$complete-task {task-ref}
```

`watch-pr` 为主路径；上面的 `complete-task` 备选块只跳过主动轮询，不跳过 required checks，也不保证立即归档。

## 注意事项

- 必须检查分支中的全部提交，而不是只看最后一个
- `create-pr` 不能把 type label 映射委托给其他技能，必须在获取到 `{task-id}` 时于本技能内内联处理
- summary marker 与当前 HEAD 由 `platform-pr summary-sync` 统一包装
- 如果当前分支已存在 PR，直接告知用户 PR URL 并结束，不做重复同步
- 如果从 Issue 继承元数据失败，继续使用 task.md 和分支推断兜底

## 错误处理

- `{target}` 与 `HEAD` 之间没有可提交内容
- 推送被拒绝：建议执行 `git pull --rebase`
- 已存在 PR：直接输出当前 PR URL 并结束
- 无法访问 Issue 元数据：跳过继承并继续
- PR 创建失败且已关联 `{task-id}`：调用 `agent-infra-internal task-warning {task-id} add --step create-pr --severity ACTION_REQUIRED --code PR_CREATE_FAILED --target pr --message "{reason}" --action "修复推送、权限或平台问题后重跑 create-pr"` 提交结构化 warning 意图，不写 `pr_number`
- PR 摘要评论失败且已关联 `{task-id}`：按 `.agents/rules/pr-sync.md` 记录 `COMMENT_SYNC_FAILED` 告警，不回滚已创建 PR
