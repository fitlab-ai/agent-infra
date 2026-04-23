---
name: release
description: "执行版本发布流程"
---

# 版本发布

执行指定版本的版本发布流程。

<!-- TODO: 根据你的项目发布流程调整以下步骤 -->

## 执行流程

### 1. 解析并验证版本号

从参数中提取版本。必须匹配 `X.Y.Z` 格式。

解析组件：
- MAJOR = X，MINOR = Y，PATCH = Z
- 发布版本 = `X.Y.Z`

如果格式无效，报错："Version format incorrect, expected X.Y.Z (e.g. 1.2.3)"

### 2. 验证工作区干净

```bash
git status --short
```

如果有未提交的变更，报错："Workspace has uncommitted changes. Please commit or stash first."

### 3. 发布前验证

<!-- TODO: 替换为你的项目发布前验证步骤 -->

运行所有在准备发布前必须通过的检查：

```bash
git branch --show-current
# TODO: 替换为你的项目测试/构建验证命令
```

验证要求：
- 确认发布使用的是项目规定的分支
- 运行你的发布流程要求的完整校验命令

处理规则：
- 如果当前分支不符合预期，按项目策略输出警告或直接退出
- 如果任何验证命令失败，停止发布流程并先修复问题

### 4. 更新版本引用

<!-- TODO: 替换为你的项目版本更新步骤 -->

搜索项目文件中的版本引用并更新：

```bash
# 查找包含版本引用的文件
# 搜索当前版本模式
# 更新版本字符串
```

**常见需要更新的文件**：
- `package.json`（Node.js）
- `package-lock.json`（Node.js；更新 `package.json` 后运行 `npm install --package-lock-only` 同步锁文件）
- `pom.xml`（Maven）
- `setup.py` / `pyproject.toml`（Python）
- `version.go`（Go）
- `README.md`（文档）
- `SECURITY.md` / `SECURITY.zh-CN.md`（支持版本表格）

**排除以下目录的版本替换**：
- `.agents/`、`.agents/workspace/`、`.claude/`、`.codex/`、`.gemini/`、`.opencode/`（AI 工具配置）

如果项目使用 `package-lock.json`，在更新 `package.json` 后运行 `npm install --package-lock-only`，确保锁文件中的版本号保持同步。

### 5. 重新生成构建产物

<!-- TODO: 替换为你的项目产物重建步骤 -->

如果版本更新会影响生成文件、内嵌元数据或打包产物，现在重新生成它们：

```bash
# TODO: 替换为你的项目构建/重建命令
```

执行要求：
- 在更新版本引用后运行，确保生成产物使用最新版本号
- 如果项目没有生成产物，请在项目特化版本中明确说明
- 如果重建失败，停止发布流程并先修复构建问题

### 6. 创建发布提交

```bash
git add -A
git commit -m "chore: release v{version}"
```

### 7. 创建 Git 标签

```bash
git tag v{version}
```

### 8. 管理里程碑

为已发布版本关闭对应版本里程碑，并为下一轮创建缺失的规划里程碑。

执行：

```bash
bash .agents/skills/release/scripts/manage-milestones.sh "$MAJOR" "$MINOR" "$PATCH"
```

脚本负责：
- 执行前先读取 `.agents/rules/label-milestone-setup.md`
- 使用其中的 milestone 查询与更新命令读取和调整当前里程碑
- 在 `{MAJOR}.{MINOR}.{PATCH}` 存在且仍为开启状态时将其关闭
- 确保 `{MAJOR}.{MINOR}.{PATCH+1}` 与 `{MAJOR}.{MINOR}.x` 存在
- 当 `PATCH=0` 时，同时确保 `{MAJOR}.{MINOR+1}.0` 与 `{MAJOR}.{MINOR+1}.x`
- 输出包含已发布里程碑动作和新建数量的汇总

### 9. 输出摘要

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTools`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

```
版本 v{version} 已准备好发布。

发布信息：
- 版本：{version}
- 发布提交：{commit-hash}
- 标签：v{version}

已更新文件数：{数量}

下一步（手动执行）：

1. 推送分支：
   git push origin {current-branch}

2. 推送标签：
   git push origin v{version}

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
3. **发布前验证**：将步骤 3 的 TODO 替换为你的项目所需的分支、测试和验证命令
4. **生成产物**：如果版本变化会影响生成文件、打包产物或内嵌元数据，需要将步骤 5 的 TODO 替换为实际命令
5. **发布自动化**：如果推送标签会触发 CI/CD 或包发布，请先确认所需凭据和流水线配置
6. **版本替换范围**：通过搜索确定需要更新哪些文件；排除 AI 工具目录
7. **适配你的项目**：以上版本更新和产物重建步骤是通用的；请根据你的项目版本方案进行定制
8. **里程碑联动**：发布时自动创建下一轮里程碑；如果里程碑体系未初始化，建议先运行 `init-milestones`

## 错误处理

- 版本格式无效：提示正确格式并退出
- 工作区不干净：提示提交或暂存
- 验证失败：显示失败的检查并停止发布流程
- 产物重建失败：显示构建错误并停止发布流程
- Git 操作失败：显示错误并提供回滚说明
