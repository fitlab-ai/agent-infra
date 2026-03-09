---
name: update-ai-collaboration
description: >
  更新当前项目的 AI 协作基础设施和项目治理配置，使其与最新的 ai-collaboration-installer 模板保持一致。
  智能合并模板变更，同时保留项目特定的定制内容。
---

# 更新项目

## 步骤 1：读取项目配置
读取项目根目录的 `collaborator.json`，提取：
- `source`
- `project`
- `org`
- `language`
- `modules`
- `templateSource`
- `files.managed` / `files.merged` / `files.ejected`

## 步骤 2：定位并刷新模板源

1. 如果 `~/.ai-collaboration-installer/` 不存在，报错并停止：
   "模板源未找到。请先安装：
   curl -fsSL https://raw.githubusercontent.com/fitlab-ai/ai-collaboration-installer/main/install.sh | sh"
2. 执行 `git -C ~/.ai-collaboration-installer pull` 拉取最新模板
3. 从 `~/.ai-collaboration-installer/` 读取

再根据 `templateSource`（默认：`templates/`）定位模板根目录。
所有更新输入都必须先从该模板树渲染，不能直接读取项目自身的文件。

## 步骤 3：确定更新范围
只处理 modules 中列出的模块。

## 步骤 4：处理 managed 文件

对 `files.managed` 中的每个路径（按启用模块过滤）：
1. 从 `{templateSource}` 读取对应模板
2. 按 `language` 选择语言版本：
   - `zh-CN`：优先使用 `.zh-CN.*` 变体，输出到去掉 `.zh-CN.` 后缀的目标路径；
     跳过对应的英文文件。若无 `.zh-CN.*` 变体则回退到英文文件。
   - `en`（默认）：使用非 `.zh-CN.*` 文件，跳过 `.zh-CN.*` 文件。
   - 每个目标路径只输出一种语言版本。
3. 渲染占位符：
   - 文件内容：`{project}`、`{org}`
   - 路径或文件名：`_project_`
4. 适配项目名、组织名、分支前缀等项目引用
5. 覆盖写入本地项目
6. 模板新增而本地不存在的文件要创建
7. 模板已删除的文件只提示用户，不自动删除

## 步骤 5：处理 merged 文件（AI 智能合并）
先从 `{templateSource}` 渲染出模板最新版，再读取本地当前文件。
**如果本地文件不存在**（首次安装），直接写入渲染后的模板，跳过合并。
如果本地文件存在，识别标准部分和用户定制，产出合并结果。

**合并原则**：
- 有疑问时保留用户内容
- 不静默删除用户添加的内容

## 步骤 6：处理 ejected 文件
- **本地文件已存在**：不触碰（ejected = 用户完全拥有）
- **本地文件不存在**（首次安装）：从模板渲染并写入一份，后续更新跳过

## 步骤 7：更新 collaborator.json
更新 `templateVersion` 为模板源当前版本。
除非用户明确要求迁移模板目录，否则保持 `templateSource` 不变。

## 步骤 8：同步 Codex prompts 到全局目录

如果 `.codex/scripts/install-prompts.sh` 存在，执行它将 `.codex/commands/`
下的所有命令同步到 `~/.codex/prompts/`，确保新渲染的命令在 Codex CLI 中立即可用。

```bash
bash .codex/scripts/install-prompts.sh
```

## 步骤 9：输出报告

**停止**：不要对项目做其他更改。
