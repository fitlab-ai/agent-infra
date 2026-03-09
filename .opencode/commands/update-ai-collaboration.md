---
description: 通过重新渲染 templates/ 来更新项目 AI 协作配置
agent: general
subtask: false
---

通过重新渲染 `templates/` 将现有项目的 AI 协作配置更新到最新版本。

1. **读取当前配置**

读取项目根目录的 `collaborator.json`。

如果不存在，回复：
"未找到现有配置。请先运行 `ai-collaboration-installer init`。"
然后 STOP。

2. **定位并刷新模板源**

- 当 `source` 为 `self` 时使用当前仓库
- 否则执行 `git -C ~/.ai-collaboration-installer pull` 拉取最新模板，再使用 `~/.ai-collaboration-installer/`
- 如果 `~/.ai-collaboration-installer/` 不存在，报错并停止
- 根据 `templateSource`（默认 `templates/`）定位模板根目录

3. **渲染 managed 文件**

对 `files.managed` 中的文件：
- 从 `templates/` 渲染
- 选择正确语言版本
- 替换 `ai-collaboration-installer`、`fitlab-ai`、`_project_`
- 覆盖本地 managed 文件
- 创建新增模板文件
- 对模板源已删除的文件只提示，不自动删除

4. **合并 merged 文件**

对 `files.merged` 中的文件：
- 先渲染最新模板版本
- 如果本地文件不存在，直接写入渲染后的模板（首次安装）
- 否则与本地文件比较
- 更新模板负责的标准内容
- 保留用户自定义内容
- 有冲突时优先保留用户内容并注明差异

5. **处理 ejected 文件**

- 本地文件已存在：不触碰
- 本地文件不存在（首次安装）：从模板渲染一份

6. **刷新 collaborator.json**

更新 `templateVersion`，并在用户没有明确要求迁移模板目录时保持
`templateSource` 不变。

7. **同步 Codex prompts**

如果 `.codex/scripts/install-prompts.sh` 存在，执行它将命令同步到 `~/.codex/prompts/`。

8. **报告变更**

列出已更新的 managed 文件、已合并的 merged 文件、已跳过的 ejected 文件、
新增文件以及需要人工跟进的项。

**下一步：** 审查更新后的配置文件。
