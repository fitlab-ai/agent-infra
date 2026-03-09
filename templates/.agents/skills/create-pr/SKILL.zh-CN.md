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

### 8. 输出结果

```
PR created: {pr-url}

Next steps (if in task workflow):
- Sync progress: execute the sync-pr skill with {task-id}
- Complete task: execute the complete-task skill with {task-id}
```

## 注意事项

1. **遵循 PR 模板**：填写模板中所有必要部分
2. **参考风格**：匹配最近合并的 PR 的格式和风格
3. **标题格式**：遵循 Conventional Commits 或项目规范
4. **所有提交都重要**：分析分支中的**所有**提交，而不仅仅是最新的

## 错误处理

- 无提交可推送：提示 "No commits found between {target} and HEAD"
- 推送被拒绝：建议先执行 `git pull --rebase`
- PR 已存在：显示已有的 PR URL
