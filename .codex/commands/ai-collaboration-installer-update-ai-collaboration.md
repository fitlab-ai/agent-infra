---
description: 通过重新渲染最新 templates/ 来更新项目 AI 协作配置
usage: /prompts:ai-collaboration-installer-update-ai-collaboration
---

# 更新项目

将当前项目的 AI 协作基础设施和项目治理更新到最新的 ai-collaboration-installer 模板。智能合并模板变更，同时保留项目特定的自定义内容。

## 步骤 1：读取项目配置

读取项目根目录的 `collaborator.json`。
提取：source、project、org、language、modules、templateSource、files（managed/merged/ejected 列表）。

## 步骤 2：定位并刷新模板源

如果 source 为 "self"（ai-collaboration-installer 自身更新），使用当前仓库。
否则：
1. 如果 `~/.ai-collaboration-installer/` 不存在，报告错误并停止：
   "模板源未找到。请先安装：
   `curl -fsSL https://raw.githubusercontent.com/fitlab-ai/ai-collaboration-installer/main/install.sh | sh`"
2. 执行 `git -C ~/.ai-collaboration-installer pull` 拉取最新模板。
3. 从 `~/.ai-collaboration-installer/` 读取。

根据 `templateSource`（默认 `templates/`）定位模板根目录。

## 步骤 3：确定更新范围

仅处理 `collaborator.json.modules` 中列出的模块所属文件。

## 步骤 4：处理受管文件

对 `files.managed` 中的每个路径（按活跃模块过滤）：
1. 从 `{templateSource}` 渲染对应文件
2. 根据 `language` 设置选择语言版本
3. 替换文件内容中的 `ai-collaboration-installer`、`fitlab-ai` 以及路径中的 `_project_`
4. 适配项目引用（项目名、组织、分支前缀）
5. 写入项目（覆盖现有文件）
6. 模板中的新文件 -> 创建
7. 模板中已删除的文件 -> 标记提醒用户，不自动删除

## 步骤 5：处理合并文件（AI 智能合并）

对 `files.merged` 中的每个路径：
1. 从 `{templateSource}` 渲染最新模板
2. 读取当前本地文件。**如果本地文件不存在**（首次安装），直接写入渲染后的模板，跳过合并
3. 分析标识模板标准部分和用户自定义内容
4. 生成合并结果，保留用户自定义内容

**合并原则**：不确定时保留用户内容，不静默删除用户添加的内容。

## 步骤 6：处理 ejected 文件

- **本地文件已存在**：不触碰
- **本地文件不存在**（首次安装）：从模板渲染并写入一份

## 步骤 7：更新 collaborator.json
刷新 `templateVersion`。
除非用户明确要求迁移模板目录，否则保持 `templateSource` 不变。

## 步骤 8：同步 Codex prompts

如果 `.codex/scripts/install-prompts.sh` 存在，执行它将命令同步到 `~/.codex/prompts/`。

## 步骤 9：输出报告

**停止**：不要对项目进行其他更改。
