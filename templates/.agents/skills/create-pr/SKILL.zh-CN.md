---
name: create-pr
description: "创建 Pull Request 到目标分支"
---

# 创建 Pull Request

创建 Pull Request，并在与任务关联时立即补齐核心元数据和 reviewer 摘要。

## 执行流程

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

读取 `.github/PULL_REQUEST_TEMPLATE.md`（如存在），参考最近合并的 PR 风格，并收集 `<target-branch>` 到 `HEAD` 的全部提交。

> 模板处理、HEREDOC 正文生成和 `Generated with AI assistance` 要求见 `reference/pr-body-template.md`。编写正文前先读取 `reference/pr-body-template.md`。

### 4. 检查远程分支状态

确认当前分支是否已有 upstream；必要时执行 `git push -u origin <current-branch>`。

### 5. 创建 PR

先检查当前分支是否已经存在 PR；如果已存在，直接告知用户 PR URL 并结束，不要重复执行元数据同步或摘要发布。

执行前先读取 `.agents/rules/issue-pr-commands.md`，并按其中的前置步骤完成认证和代码托管平台检测；随后按其中的 “创建 PR” 命令创建 PR。

如果获取到 `{task-id}` 且对应任务提供了 `issue_number`，必须在 PR 正文中保留 `Closes #{issue-number}`。

### 6. 同步 PR 元数据

对获取到 `{task-id}` 的 PR，立即同步这些核心元数据：
- 按 `.agents/rules/issue-pr-commands.md` 查询标准 label / Issue / PR 元数据
- 按 `.agents/rules/issue-pr-commands.md` 的 PR 更新命令和权限降级规则处理 type label
- 将 Issue 当前的 `in:` labels 复制到 PR（不重新计算，不反向更新 Issue）
- 按 `.agents/rules/milestone-inference.md` 的「阶段 3：`create-pr`」及其权限规则复用 Issue milestone
- 通过 `Closes #{issue-number}` 保持 Development 关联

### 7. 发布审查摘要

读取最新的上下文产物：`plan.md` / `plan-r{N}.md`、`implementation.md` / `implementation-r{N}.md`、`review.md` / `review-r{N}.md`、`refinement.md` / `refinement-r{N}.md`（存在时）。

基于这些产物聚合 reviewer 摘要，并使用隐藏标记维护唯一且幂等的摘要评论。

> 隐藏标记、幂等 summary 评论更新、review history 格式，以及评论创建/更新规则见 `reference/comment-publish.md`（其内联引用 `.agents/rules/pr-sync.md`）。发布摘要前先读取 `reference/comment-publish.md`。
>
> **Shell 安全规则**（发布评论前必读）：
> 1. `{comment-body}` 必须替换为**实际的内联文本**。先读取文件，再将全文粘贴到 heredoc body 中。**禁止**在 `<<'EOF'` 内部使用 `$(cat ...)`、`$(< ...)`、`$(...)`、`${...}`。
> 2. 构造含 `<!-- -->` 的字符串时，**禁止使用 `echo`**。统一使用 `cat <<'EOF'` heredoc 或 `printf '%s\n'` 构造。
> 3. 同样的安全约束已在 `.agents/rules/pr-sync.md` 中重述，调用该 rule 后无需重复补充另一份模板规则。

### 8. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

如果获取到了 `{task-id}`，更新 task.md 的 `pr_number`、`updated_at`，并追加 PR Created 的 Activity Log，记录元数据同步和摘要发布结果。

### 9. 完成校验

如果本次操作关联了 `{task-id}`，运行完成校验，确认任务元数据和同步状态符合规范；如果没有任务上下文，跳过本步骤。

```bash
node .agents/scripts/validate-artifact.js gate create-pr .agents/workspace/active/{task-id} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 10. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTools`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

说明 PR URL、元数据同步结果、摘要评论结果，并在工作流真正完成后推荐执行 `complete-task {task-id}`。

## 注意事项

- 必须检查分支中的全部提交，而不是只看最后一个
- `create-pr` 不能把 type label 映射委托给其他技能，必须在获取到 `{task-id}` 时于本技能内内联处理
- 隐藏 summary 标记必须保持 `<!-- sync-pr:{task-id}:summary -->` 以兼容已有 PR 评论
- 如果当前分支已存在 PR，直接告知用户 PR URL 并结束，不做重复同步
- 如果从 Issue 继承元数据失败，继续使用 task.md 和分支推断兜底

## 错误处理

- `{target}` 与 `HEAD` 之间没有可提交内容
- 推送被拒绝：建议执行 `git pull --rebase`
- 已存在 PR：直接输出当前 PR URL 并结束
- 无法访问 Issue 元数据：跳过继承并继续
