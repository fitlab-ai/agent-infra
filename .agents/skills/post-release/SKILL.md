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

- 提取最新 `vX.Y.Z` 标签作为刚刚发布的版本，并在后续步骤中去除 `v` 前缀得到版本号
- 如果没有找到标签，报错："No released version tag found. Please create and push a release tag first."

### 2. 验证工作区干净

```bash
git status --short
```

- 如果存在未提交变更，报错："Workspace has uncommitted changes. Please commit or stash first."

### 3. 准备下一个开发版本

```bash
npm version prerelease --preid=alpha --no-git-tag-version
npm install --package-lock-only
```

- 读取新的 prerelease 版本号
- 使用编辑工具更新 `.agents/.airc.json` 中的 `templateVersion` 为 `v{new-version}`
- 确保 `package.json`、`package-lock.json` 和 `.agents/.airc.json` 中的版本保持一致

### 4. 重新生成内联产物

```bash
node scripts/build-inline.js
cp templates/.agents/skills/update-agent-infra/scripts/sync-templates.js \
  .agents/skills/update-agent-infra/scripts/sync-templates.js
```

- 版本更新后必须重建内联产物，避免嵌入的默认模板版本号过期
- 如果命令失败，停止并先修复构建问题

### 5. 录制执行动图（可选）

```bash
command -v vhs >/dev/null 2>&1
```

- 如果 `vhs` 可用，执行 `npm run demo:regen`
- 如果 `vhs` 不可用，跳过录制并提示用户稍后手动生成演示动图

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
- 动图录制：{结果描述}

下一步（手动执行）：
- 推送分支：git push origin {current-branch}
```

## 注意事项

1. **无参数设计**：版本号通过最新标签自动检测，不需要手动传参
2. **需要干净工作区**：避免将无关变更混入版本 bump 提交
3. **VHS 可选**：缺少 `vhs` 或 `ffmpeg` 时允许跳过，不阻塞其余步骤
4. **本地执行**：本技能只准备本地变更，不自动推送

## 错误处理

- 未找到发布标签：提示先完成版本发布并推送标签
- 工作区不干净：提示先提交或暂存
- 版本 bump 失败：显示命令错误并停止
- 内联产物重建失败：显示构建错误并停止
- Git 提交失败：显示错误并保留当前工作区供人工处理
