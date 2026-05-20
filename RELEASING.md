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
- npmjs.com 已为 `@fitlab-ai/agent-infra` 配置 GitHub Actions Trusted Publisher（绑定字段见下文 [npm Trusted Publisher 配置](#npm-trusted-publisher-配置)）

## npm Trusted Publisher 配置

npm 发布走 GitHub Actions OIDC + npm Trusted Publishing，CI 不再读取长期 `NPM_TOKEN`。首次切换前，维护者必须在 npmjs.com 完成一次性绑定。

### 一次性绑定字段（npmjs.com 侧）

到 `https://www.npmjs.com/package/@fitlab-ai/agent-infra/access` → **Publishing access** → **Add Trusted Publisher**，填写：

| 字段 | 取值 |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `fitlab-ai` |
| Repository | `agent-infra` |
| Workflow filename | `release.yml` |
| Environment name | 留空 |

`Workflow filename` 必须与 `.github/workflows/release.yml` 完全一致；如未来重命名 workflow，需同步更新 npmjs.com 端绑定，否则发布步骤会因 OIDC 声明不匹配而 401/403。

### 设计取舍

- **Environment name 留空**：避免在 npmjs.com 与 workflow 之间多维护一个必须精确匹配的字段；仓库当前无 environment 级 reviewer approval 需求。
- **`NPM_TOKEN` secret 不在代码中自动删除**：删除是一次性治理动作，必须由维护者在首次 OIDC 发布验证通过后手动到 GitHub Settings 执行。代码自动删除会破坏 [回滚到 token 发布模式（应急）](#回滚到-token-发布模式应急) 的兜底路径。

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
- 升级 npm 到支持 Trusted Publishing 的版本
- 再次执行测试
- 使用 `gh release create --generate-notes` 创建 GitHub Release
- 校验 `package.json` 版本与 tag 一致
- 使用 GitHub Actions OIDC 和 `npm publish --provenance` 发布 `@fitlab-ai/agent-infra`

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
- 通过 GitHub Actions OIDC 和 npm Trusted Publishing 执行 `npm publish --provenance`

发布前建议再次确认：

- npmjs.com 已完成 Trusted Publisher 绑定，字段值与上文 [npm Trusted Publisher 配置](#npm-trusted-publisher-配置) 一致
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

### 撤回错误版本（tag 回滚）

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

### 回滚到 token 发布模式（应急）

如果首次 OIDC 发布因 npmjs.com Trusted Publisher 绑定缺失或字段不正确而失败：

1. `git revert` 移除 release.yml 中删除 `NODE_AUTH_TOKEN` / `secrets.NPM_TOKEN` 的那次改动，让默认分支重新包含 token 模式 workflow，并记下这次恢复提交的 SHA（下文记为 `<revert-commit>`）。
2. 如已删除 `NPM_TOKEN` GitHub secret，在 Settings → Secrets 重新生成。
3. 重建已失败的 tag，让它指向 `<revert-commit>`——release workflow 读的是 tag 指向 commit 里的 workflow 文件，仅在分支上 revert 而不重建 tag，重跑仍会用回旧 commit 里的 OIDC workflow：

   ```bash
   git push origin --delete vX.Y.Z
   gh release delete vX.Y.Z --yes        # 删除 tag 创建时自动生成的 GitHub Release
   git tag -f vX.Y.Z <revert-commit>
   git push origin vX.Y.Z
   ```

   注意：这会改变 `vX.Y.Z` 指向的 commit。如果发布策略不接受 tag 改写（签名审计、下游缓存等），改为在 `<revert-commit>` 上发布下一个补丁版本号（即 `vX.Y.{Z+1}`，例如失败的 `v1.2.3` 改发 `v1.2.4`）。
4. 等 token 模式 release workflow 成功并完成 npm publish 后，再在另外的窗口排查 npmjs.com Trusted Publisher 绑定字段；修复后用新 alpha tag 重做 OIDC 切换。

应急原则：先恢复已知可用的发布路径，再排查 npmjs.com 配置；不要在 release 卡住时反复改动 workflow。

## 后续优化边界

当前流程采用渐进式自动化：

- GitHub Release 自动化：已纳入流程
- npm publish 自动化：已纳入流程，推送标签后由 CI 自动执行

如后续需要全自动 npm 发布，应单独评估：

- 发布失败时的回滚方案
- 预发布版本和稳定版本的区分机制
