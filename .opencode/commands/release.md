---
name: "release"
description: "执行版本发布流程"
usage: "/release <version>"
---

# Release Command

## 功能说明

执行标准化的版本发布流程。参数：$ARGUMENTS（X.Y.Z 格式）。


## 执行步骤

### 步骤 1：解析并验证版本号

从 `$ARGUMENTS` 中提取版本号。必须匹配 `X.Y.Z` 格式。

**解析版本组件**：
- MAJOR = X, MINOR = Y, PATCH = Z
- 发布版本 = `X.Y.Z`

如果格式不正确，报错退出：`错误：版本号格式不正确，期望格式为 X.Y.Z（例如 1.2.3）`

### 步骤 2：确认工作区状态

```bash
git status --short
```

如果有未提交的更改，报错退出：`错误：工作区有未提交的更改，请先提交或暂存后再执行发布`

### 步骤 3：更新版本引用

更新以下文件中的版本号：

1. `bin/ai-collaboration-installer` 中的 `VERSION="X.Y.Z"`
2. `collaborator.json` 中的 `"version": "X.Y.Z"`

使用 Grep 搜索旧版本号确认无遗漏，使用 Edit 工具更新。

**必须排除的目录**（AI 工具配置，不应被版本替换影响）：
- `.agents/`, `.ai-workspace/`, `.claude/`, `.codex/`, `.gemini/`, `.opencode/`

### 步骤 4：创建 Release commit

```bash
git add -A
git commit -m "chore: release v{version}"
```

### 步骤 5：创建 Git 标签

```bash
git tag v{version}
```

### 步骤 6：输出总结

```
✅ 版本发布完成

**发布信息**:
- 发布版本: {version}
- Release commit: {commit-hash}
- Tag: v{version}

**替换文件数**: {count} 个

**后续手动操作**:

1. 推送标签：
   git push origin v{version}

2. 推送分支：
   git push origin {current-branch}

3. （可选）生成 Release Notes：
   - Claude Code / OpenCode: `/create-release-note {version}`
   - Gemini CLI: `/ai-collaboration-installer:create-release-note {version}`
   - Codex CLI: `/prompts:ai-collaboration-installer-create-release-note {version}`
```

## 使用示例

```bash
/release 1.2.3
```

## 回滚方式

如果发布过程中出错或需要回滚：

```bash
# 删除标签
git tag -d v{version}

# 回退 commit
git reset --soft HEAD~1

# 恢复工作区
git checkout -- .
```

## 注意事项

1. **工作区必须干净**：执行前确保没有未提交的更改
2. **不会自动推送**：所有操作仅在本地完成，推送由用户手动执行
3. **不含构建验证**：建议在发布前运行 `/test` 验证
4. **版本号替换范围**：由 Grep 全局搜索决定，确保所有引用都被更新；排除 AI 工具配置目录
5. **根据项目调整**：以上步骤为通用流程，请根据项目的版本管理方式定制

## 错误处理

- 版本号格式错误：提示正确格式并退出
- 工作区不干净：提示先提交或暂存更改
- Git 操作失败：显示错误信息并提供回滚指引

## 相关命令

- `/create-release-note <version>` - 生成 Release Notes
- `/commit` - 提交代码
- `/test` - 运行测试
