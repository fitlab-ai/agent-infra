# 发布策略

## 目标

本文档定义 `agent-infra` 的版本策略、发布前检查项和标准发布流程，确保 CLI、模板和仓库元数据在每次发布时保持一致。

## 版本号策略

项目使用语义化版本（SemVer）：`MAJOR.MINOR.PATCH`。

- `MAJOR`：CLI 命令发生不兼容变更、模板目录结构出现破坏性调整、移除或重定义 `.agents/.airc.json` 公共配置项
- `MINOR`：新增 AI 工具支持、新增技能或工作流模板、新增 CLI 功能且保持向后兼容
- `PATCH`：Bug 修复、模板内容修正、文档更新、非破坏性流程优化

当前项目处于 `0.x` 阶段。发布前仍按上述规则判断变更级别，但允许在进入 `1.0.0` 前继续迭代接口和模板细节。

## 版本来源

发布版本必须同时更新以下两个文件，并保持完全一致：

- `package.json`
- `.agents/.airc.json`

其中：

- `package.json` 表示 CLI 包版本
- `.agents/.airc.json` 表示模板和协作基线版本

开发期版本使用 `-alpha.N` 后缀，例如 `0.1.0-alpha.1`，用于明确标识当前版本尚未正式发布。

发布标签使用 `vX.Y.Z` 格式，例如 `v0.1.0`。

## 发布前检查清单

发版前必须确认以下事项：

- 工作区干净，没有未提交变更
- `package.json` 与 `.agents/.airc.json` 的版本号一致
- `npm test` 全部通过
- 待发布内容已经过代码审查
- 本次变更的 PR 标签和标题足以生成准确的 GitHub Release Notes
- 仓库中的 `NPM_TOKEN` GitHub Actions secret 有效，并具备 `@fitlab-ai/agent-infra` 发布权限

## 标准发布流程

### 1. 准备版本

在 AI TUI 中执行 `release` 技能：

- Claude Code / OpenCode：`/release X.Y.Z`
- Gemini CLI：`/agent-infra:release X.Y.Z`
- Codex CLI：`$release X.Y.Z`

该技能负责：

- 校验版本号格式
- 检查工作区是否干净
- 警告当前分支是否不是 `main`
- 运行测试
- 同步更新 `package.json` 和 `.agents/.airc.json`
- 创建发布提交和本地标签

### 2. 推送分支和标签

```bash
git push origin <current-branch>
git push origin vX.Y.Z
```

推送标签后，GitHub Actions 会自动运行 `.github/workflows/release.yml`：

- checkout 代码
- 设置 Node.js 环境
- 再次执行测试
- 使用 `gh release create --generate-notes` 创建 GitHub Release
- 校验 `package.json` 版本与 tag 一致
- 使用 `npm publish --provenance` 发布 `@fitlab-ai/agent-infra`

`.github/release.yml` 负责定义自动生成发布说明时的分类规则。

### 3. 生成和补充发布说明

如需先在本地整理说明，可执行：

- Claude Code / OpenCode：`/create-release-note X.Y.Z [PREVIOUS_VERSION]`
- Gemini CLI：`/agent-infra:create-release-note X.Y.Z [PREVIOUS_VERSION]`
- Codex CLI：`$create-release-note X.Y.Z [PREVIOUS_VERSION]`

如果 GitHub 自动生成的说明已经足够，可以直接使用 Release 页面内容；否则手动补充亮点、迁移提示和已知限制。

### 4. npm 发布（自动）

推送 `vX.Y.Z` 标签后，`npm-publish` job 会在 CI 中自动执行：

- 校验 `package.json` 中的版本号与 Git tag 一致
- 运行 `npm test`
- 使用 `NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }}` 执行 `npm publish --provenance`

发布前建议再次确认：

- 仓库已配置有效的 `NPM_TOKEN` secret
- `fitlab-ai` scope 或对应组织权限已经在 npm 准备完成
- 目标版本尚未在 npm registry 中存在

### 5. 发布后处理

在发布标签推送并完成 CI 发布后，执行 `post-release` 技能准备下一轮开发版本：

- Claude Code / OpenCode：`/post-release`
- Gemini CLI：`/agent-infra:post-release`
- Codex CLI：`$post-release`

该技能负责：

- 检测最新已发布标签并解析版本
- bump 到下一个开发版本
- 重建内联产物
- 可选录制最新执行动图
- 创建发布后处理提交

## 回滚流程

如果本地发布准备完成后发现版本错误，可按 release 技能中的回滚步骤处理：

```bash
git tag -d vX.Y.Z
git reset --soft HEAD~1
git checkout -- .
```

如果标签已经推送，还需要额外删除远端标签并处理已创建的 GitHub Release：

```bash
git push origin --delete vX.Y.Z
gh release delete vX.Y.Z --yes
```

## 后续优化边界

当前流程采用渐进式自动化：

- GitHub Release 自动化：已纳入流程
- npm publish 自动化：已纳入流程，推送标签后由 CI 自动执行

如后续需要全自动 npm 发布，应单独评估：

- 发布失败时的回滚方案
- 预发布版本和稳定版本的区分机制
