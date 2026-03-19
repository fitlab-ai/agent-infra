---
name: create-pr
description: >
  创建 Pull Request 到指定或自动推断的目标分支。
  当用户要求创建 PR 时触发。可选参数：目标分支。
---

# 创建 Pull Request

创建 Pull Request。可选参数：目标分支。

## 执行流程

### 1. 确定目标分支

- 如果用户提供了参数（例如 `main`、`develop`、`3.6.x`），使用其作为目标分支
- 如果没有参数，自动检测：
  ```bash
  git branch --show-current
  git log --oneline --decorate --first-parent -20
  ```
  **检测规则**：
  - 当前在 main/trunk 分支 -> 目标是该分支
  - 当前在 feature 分支 -> 从日志装饰中找到最近的父分支
  - 无法确定 -> 询问用户

### 2. 读取 PR 模板

从仓库中读取 `.github/PULL_REQUEST_TEMPLATE.md`。

如果模板不存在，使用标准格式。

### 3. 参考最近合并的 PR

```bash
gh pr list --limit 3 --state merged --json number,title,body
```

以此作为风格和格式参考。

### 4. 分析当前分支变更

```bash
git status
git log <target-branch>..HEAD --oneline
git diff <target-branch>...HEAD --stat
git diff <target-branch>...HEAD
```

理解将包含在此 PR 中的所有提交和变更。查看**所有**提交，而不仅仅是最新的。

### 5. 检查远程分支状态

```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null
```

### 6. 如未推送则先推送

```bash
git push -u origin <current-branch>
```

### 7. 创建 PR

- 遵循 `.github/PULL_REQUEST_TEMPLATE.md` 格式填写所有部分
- 参考最近合并的 PR 的风格
- 使用 HEREDOC 格式传递 body
- PR 必须以 `Generated with AI assistance` 结尾

```bash
gh pr create --base <target-branch> --title "<title>" --body "$(cat <<'EOF'
<按模板填写的完整 PR 描述>

Generated with AI assistance
EOF
)"
```

### 8. 同步 PR 元数据（如果与任务相关）

如果存在关联的活跃任务，在创建 PR 后立即同步以下元数据：

**a) 检查 label 体系是否已初始化**

执行：

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

- 返回 `0` -> 先执行 `init-labels` 技能，然后重新执行本步骤
- 返回非 `0` -> 继续

**b) 同步 type label**

根据 task.md 的 `type` 字段按下表映射：

| task.md type | GitHub label |
|---|---|
| bug、bugfix | `type: bug` |
| feature | `type: feature` |
| enhancement | `type: enhancement` |
| refactor、refactoring | `type: enhancement` |
| documentation | `type: documentation` |
| dependency-upgrade | `type: dependency-upgrade` |
| task | `type: task` |
| 其他 | 跳过 |

如果 task.md 的 `type` 可以映射到标准 type label，执行：

```bash
gh pr edit {pr-number} --add-label "{type-label}"
```

**c) 同步 in: label**

从实现报告或分析报告提取受影响模块，确认对应 label 存在后执行：

```bash
gh pr edit {pr-number} --add-label "in: {module}"
```

只添加，不移除现有的 `in:` labels。

**d) 同步 Milestone**

复用 `sync-pr` 的里程碑推断策略：
- 先检查 PR 是否已有 milestone
- 再检查 task.md 是否显式指定 `milestone`
- 否则基于当前分支、版本分支或最新 tag 推断
- 最终回退到 `General Backlog`

找到目标后执行：

```bash
gh pr edit {pr-number} --milestone "{milestone-title}"
```

**e) 同步 Development 关联**

如果 task.md 包含 `issue_number`，读取 PR body：

```bash
gh pr view {pr-number} --json body --jq '.body // ""'
```

如果 body 不包含以下任一关键词：
- `Closes #{issue-number}`
- `Fixes #{issue-number}`
- `Resolves #{issue-number}`

则在末尾追加：

```bash
gh pr edit {pr-number} --body "$(cat <<'EOF'
{existing-body}

Closes #{issue-number}
EOF
)"
```

### 9. 更新任务状态（如果与任务相关）

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

如果有关联的活跃任务，更新 `.agent-workspace/active/{task-id}/task.md`：
- `pr_number`：{pr-number}
- `updated_at`：{当前时间}
- **追加**到 `## Activity Log`（不要覆盖之前的记录）：
  ```
  - {yyyy-MM-dd HH:mm:ss} — **PR Created** by {agent} — PR #{pr-number} created
  ```

### 10. 输出结果

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

> **⚠️ NEXT STEP CHECK — 你必须先判断创建 PR 后的真实下一步，再展示下面的命令：**
>
> - 如果 `task.md` 有有效 `issue_number`，且需要把 PR 状态或审查摘要同步回任务上下文，优先提示「发布审查摘要（可选）」
> - 如果所有工作流步骤已经完成，或创建 PR 后下一步就是归档任务，提示「完成任务」
> - 如果以上两者都适用，必须明确顺序：**先同步 PR 进度，再完成任务**
>
> **禁止把「完成任务」写成唯一下一步，如果仍需要同步进度或补充 PR 上下文。**

```
PR 已创建：{pr-url}

元数据同步：
- Labels：{type-label-result}, {in-label-result}
- Milestone：{milestone-result}
- Development：{development-result}

下一步（如在任务工作流中）：
- 发布审查摘要（可选；有关联任务或需要同步 PR 状态时建议先执行）：
  - Claude Code / OpenCode：/sync-pr {task-id}
  - Gemini CLI：/{{project}}:sync-pr {task-id}
  - Codex CLI：$sync-pr {task-id}
- 完成任务（所有工作流步骤完成后执行）：
  - Claude Code / OpenCode：/complete-task {task-id}
  - Gemini CLI：/{{project}}:complete-task {task-id}
  - Codex CLI：$complete-task {task-id}
```

## 注意事项

1. **遵循 PR 模板**：填写模板中所有必要部分
2. **参考风格**：匹配最近合并的 PR 的格式和风格
3. **标题格式**：遵循 Conventional Commits 或项目规范
4. **所有提交都重要**：分析分支中的**所有**提交，而不仅仅是最新的
5. **自动同步元数据**：如果与任务相关，create-pr 必须在创建后立即补齐 labels、milestone 和 development 关联

## 错误处理

- 无提交可推送：提示 "No commits found between {target} and HEAD"
- 推送被拒绝：建议先执行 `git pull --rebase`
- PR 已存在：显示已有的 PR URL
