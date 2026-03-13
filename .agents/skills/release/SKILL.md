---
name: release
description: >
  执行版本发布流程。当用户要求发布版本时触发。参数：版本号（X.Y.Z）。
---

# 版本发布

执行指定版本的版本发布流程。

## 执行流程

### 步骤 1：解析并验证版本号

从参数中提取版本。必须匹配 `X.Y.Z` 格式。

解析组件：
- MAJOR = X，MINOR = Y，PATCH = Z
- 发布版本 = `X.Y.Z`

如果格式无效，报错："Version format incorrect, expected X.Y.Z (e.g. 1.2.3)"

### 步骤 2：验证工作区干净

```bash
git status --short
```

如果有未提交的变更，报错："Workspace has uncommitted changes. Please commit or stash first."

### 步骤 3：发布前验证

```bash
git branch --show-current
node --test tests/*.test.js
```

验证要求：
- 检查当前分支是否为 `main`
- 运行完整测试套件

处理规则：
- 如果当前分支不是 `main`，输出警告但继续执行（某些维护场景可能需要从其他分支发布）
- 如果测试失败，报错退出并要求先修复测试

### 步骤 4：更新版本引用

更新以下文件中的版本号：

1. `package.json` 中的 `"version": "X.Y.Z"`
2. `collaborator.json` 中的 `"version": "X.Y.Z"`

如果当前工作区处于开发期 prerelease 版本（例如 `0.1.0-alpha.1`），也需要将其替换为目标正式版本 `X.Y.Z`。

使用搜索确认旧版本号（包含可能的 prerelease 后缀）无遗漏，使用编辑工具更新。

**排除以下目录的版本替换**：
- `.agents/`、`.ai-workspace/`、`.claude/`、`.codex/`、`.gemini/`、`.opencode/`（AI 工具配置）

### 步骤 5：创建发布提交

```bash
git add -A
git commit -m "chore: release v{version}"
```

### 步骤 6：创建 Git 标签

```bash
git tag v{version}
```

### 步骤 7：输出摘要

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

```
Release v{version} prepared.

Release info:
- Version: {version}
- Release commit: {commit-hash}
- Tag: v{version}

Files updated: {数量}

Next steps (manual):

1. Push branch:
   git push origin {current-branch}

2. Push tag:
   git push origin v{version}

3.（可选）生成发布说明：
   - Claude Code / OpenCode：/create-release-note {version}
   - Gemini CLI：/ai-collaboration-installer:create-release-note {version}
   - Codex CLI：$create-release-note {version}
```

### 回滚说明

如果出了问题：
```bash
# 删除标签
git tag -d v{version}

# 重置提交
git reset --soft HEAD~1

# 恢复文件
git checkout -- .
```

## 注意事项

1. **需要干净的工作区**：必须没有未提交的变更
2. **不自动推送**：所有操作仅在本地执行；用户手动推送
3. **发布前验证**：检查当前分支，并在本技能内运行 `node --test tests/*.test.js`
4. **版本替换范围**：通过搜索确定需要更新哪些文件；排除 AI 工具目录
5. **适配你的项目**：以上版本更新步骤是通用的；请根据你的项目版本方案进行定制

## 错误处理

- 版本格式无效：提示正确格式并退出
- 工作区不干净：提示提交或暂存
- 测试失败：显示测试错误并退出
- Git 操作失败：显示错误并提供回滚说明
