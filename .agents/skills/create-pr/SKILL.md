---
name: create-pr
description: "创建 Pull Request 到目标分支"
---

# 创建 Pull Request

创建 Pull Request，并在与任务关联时立即补齐核心元数据。

## 执行流程

### 1. 确定目标分支

如果用户显式提供参数就直接使用；否则根据 Git 历史和分支拓扑自动推断。

> 详细分支判断规则见 `reference/branch-strategy.md`。自动推断 base 分支前，先读取 `reference/branch-strategy.md`。

### 2. 准备 PR 正文

读取 `.github/PULL_REQUEST_TEMPLATE.md`（如存在），参考最近合并的 PR 风格，并收集 `<target-branch>` 到 `HEAD` 的全部提交。

> 模板处理、HEREDOC 正文生成和 `Generated with AI assistance` 要求见 `reference/pr-body-template.md`。编写正文前先读取 `reference/pr-body-template.md`。

### 3. 检查远程分支状态

确认当前分支是否已有 upstream；必要时执行 `git push -u origin <current-branch>`。

### 4. 创建 PR

使用 `gh pr create --base <target-branch> --title "<title>" --assignee @me --body ...` 创建 PR。

如果关联任务提供了 `issue_number`，必须在 PR 正文中保留 `Closes #{issue-number}`。

### 5. 同步 PR 元数据

对任务关联 PR，立即同步这些核心元数据：
- 执行 `gh label list --search "type:" --limit 1 --json name --jq 'length'`
- 使用 `gh pr edit {pr-number} --add-label "{type-label}"` 添加 type label
- 使用 `gh pr edit {pr-number} --add-label "in: {module}"` 添加相关 `in:` labels
- 使用 `gh pr edit {pr-number} --milestone "{milestone-title}"` 设置里程碑
- 通过 `Closes #{issue-number}` 保持 Development 关联

### 6. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

如果当前 PR 关联任务，更新 task.md 的 `pr_number`、`updated_at`，并追加 PR Created 的 Activity Log。

### 7. 告知用户

说明 PR URL、元数据同步结果，并按顺序给出两个后续动作：
- 可选执行 `sync-pr {task-id}`，发布面向 reviewer 的上下文摘要
- 当整个工作流真正完成后执行 `complete-task {task-id}`

## 注意事项

- 必须检查分支中的全部提交，而不是只看最后一个
- `create-pr` 不能把 type label 映射委托给 `sync-pr`，必须在本技能内内联处理
- 如果从 Issue 继承元数据失败，继续使用 task.md 和分支推断兜底

## 错误处理

- `{target}` 与 `HEAD` 之间没有可提交内容
- 推送被拒绝：建议执行 `git pull --rebase`
- 已存在 PR：直接输出当前 PR URL
- 无法访问 Issue 元数据：跳过继承并继续
