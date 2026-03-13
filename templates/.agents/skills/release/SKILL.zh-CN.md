---
name: release
description: >
  执行版本发布流程。当用户要求发布版本时触发。参数：版本号（X.Y.Z）。
---

# 版本发布

执行指定版本的版本发布流程。

<!-- TODO: 根据你的项目发布流程调整以下步骤 -->

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

### 步骤 3：更新版本引用

<!-- TODO: 替换为你的项目版本更新步骤 -->

搜索项目文件中的版本引用并更新：

```bash
# 查找包含版本引用的文件
# 搜索当前版本模式
# 更新版本字符串
```

**常见需要更新的文件**：
- `package.json`（Node.js）
- `pom.xml`（Maven）
- `setup.py` / `pyproject.toml`（Python）
- `version.go`（Go）
- `README.md`（文档）
- `SECURITY.md` / `SECURITY.zh-CN.md`（支持版本表格）

**排除以下目录的版本替换**：
- `.agents/`、`.ai-workspace/`、`.claude/`、`.codex/`、`.gemini/`、`.opencode/`（AI 工具配置）

### 步骤 4：创建发布提交

```bash
git add -A
git commit -m "chore: release v{version}"
```

### 步骤 5：创建 Git 标签

```bash
git tag v{version}
```

### 步骤 6：输出摘要

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

```
版本 v{version} 已准备好发布。

发布信息：
- 版本：{version}
- 发布提交：{commit-hash}
- 标签：v{version}

已更新文件数：{数量}

下一步（手动执行）：

1. 推送标签：
   git push origin v{version}

2. 推送分支：
   git push origin {current-branch}

3.（可选）生成发布说明：
   - Claude Code / OpenCode：/create-release-note {version}
   - Gemini CLI：/{{project}}:create-release-note {version}
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
3. **不验证构建**：发布前执行 test 技能进行验证
4. **版本替换范围**：通过搜索确定需要更新哪些文件；排除 AI 工具目录
5. **适配你的项目**：以上版本更新步骤是通用的；请根据你的项目版本方案进行定制

## 错误处理

- 版本格式无效：提示正确格式并退出
- 工作区不干净：提示提交或暂存
- Git 操作失败：显示错误并提供回滚说明
