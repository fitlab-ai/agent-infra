---
name: post-release
description: "执行版本发布后的后处理工作"
---

# 发布后处理

在版本标签推送完成后，执行标准化的发布后收尾流程。

## 执行流程

### 1. 检测最新发布版本

```bash
git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1
```

- 检测最新 `vX.Y.Z` 标签，并在后续步骤中去除 `v` 前缀得到版本号
- 如果没有找到标签，报错："No released version tag found. Please create and push a release tag first."

### 2. 验证工作区干净

```bash
git status --short
```

- 如果存在未提交变更，报错："Workspace has uncommitted changes. Please commit or stash first."

### 3. 准备下一个开发版本

<!-- TODO: 将此步骤替换为你的项目版本 bump 命令 -->

```bash
# TODO: 替换为你的项目发布后版本 bump 命令
# npm version prerelease --preid=alpha --no-git-tag-version
```

- 如果项目需要，记得同步锁文件或其他版本元数据
- 版本 bump 后保持所有版本引用一致

### 4. 重新生成构建产物

<!-- TODO: 将此步骤替换为你的项目产物重建命令 -->

```bash
# TODO: 替换为你的项目产物重建命令
```

- 重建所有受新版本号影响的生成文件、内嵌产物或内联模板
- 如果项目没有生成产物，请在项目特化版本中删除此步骤

### 5. 执行其他发布后任务（可选）

<!-- TODO: 添加项目特定的发布后任务，例如录制演示、发布文档站或通知下游 -->

- 示例：录制终端演示、刷新文档站、通知下游团队、更新发布面板
- 如果没有额外任务，请在项目特化版本中删除此步骤

### 6. 创建后处理提交

```bash
git add -A
git commit -m "chore: prepare next dev iteration after v{released-version}"
```

### 7. 输出摘要

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

```
发布后处理已完成。

结果摘要：
- 已发布版本：{released-version}
- 新开发版本：{new-version}
- 额外任务完成情况：{summary}

下一步（手动执行）：
- 推送分支：git push origin {current-branch}
```

## 注意事项

1. **无参数设计**：从最新标签自动检测已发布版本，不要求用户重复输入
2. **需要干净工作区**：避免把无关改动带入发布后提交
3. **项目定制**：将带 TODO 的步骤替换为你的项目实际命令
4. **仅本地执行**：本技能只准备本地变更，不自动推送

## 错误处理

- 未找到发布标签：提示用户先完成发布
- 工作区不干净：提示先提交或暂存
- 版本 bump 失败：显示命令错误并停止
- 产物重建失败：显示构建错误并停止
- Git 提交失败：显示错误并保留当前工作区供人工处理
