---
name: update-ai-collaboration
description: >
  更新当前项目的 AI 协作基础设施和项目治理配置，使其与最新的 ai-collaboration-installer 模板保持一致。
  智能合并模板变更，同时保留项目特定的定制内容。
---

# 更新项目

## 步骤 1：读取项目配置

读取项目根目录的 `collaborator.json`，提取：
- `project`、`org`
- `language`
- `modules`
- `templateSource`
- `files.managed` / `files.merged` / `files.ejected`

## 步骤 2：定位并刷新模板源

1. 如果 `~/.ai-collaboration-installer/` 不存在，报错并停止：
   "模板源未找到。请先安装：
   curl -fsSL https://raw.githubusercontent.com/fitlab-ai/ai-collaboration-installer/main/install.sh | sh"
2. 执行 `git -C ~/.ai-collaboration-installer pull` 拉取最新模板
3. 记录模板源当前 commit SHA（`git -C ~/.ai-collaboration-installer rev-parse --short HEAD`）

再根据 `templateSource`（默认：`templates/`）定位模板根目录。
所有更新输入都必须先从该模板树渲染，不能直接读取项目自身的文件。

## 步骤 3：确定更新范围并分类文件

只处理 `modules` 中列出的模块。

**文件分类优先级**（高 → 低）：
1. `files.ejected` 中列出的路径 → **ejected**（用户完全拥有，不触碰）
2. `files.merged` 中列出的路径或 glob 模式所匹配的文件 → **merged**（AI 智能合并）
3. `files.managed` 中列出的目录或路径 → **managed**（模板覆盖写入）

**关键**：一个文件即使位于 managed 目录下，只要它匹配 `files.merged` 中的任何 glob 模式，
就必须使用 merged 策略。判断时将 glob 模式与文件在项目中的相对路径进行匹配。

## 步骤 4：处理 managed 文件

对分类为 managed 的每个文件：

### 4.1 语言选择

按 `language` 字段选择：
- `zh-CN`：优先使用 `.zh-CN.*` 变体，输出到去掉 `.zh-CN.` 后缀的目标路径；
  跳过对应的英文文件。若无 `.zh-CN.*` 变体则回退到英文文件。
- `en`（默认）：使用非 `.zh-CN.*` 文件，跳过 `.zh-CN.*` 文件。
- 每个目标路径只输出一种语言版本。

### 4.2 渲染占位符

模板文件中使用两种占位符：

**内容占位符**：模板文本中的花括号包裹的 `project` 和 `org` 两个单词。
渲染时将它们分别替换为 collaborator.json 中 `project` 和 `org` 的实际值。

**路径占位符**：文件名或目录名中的 `_project_`，替换为项目名。

> **警告**：不可跳过渲染直接复制模板原文件。跳过渲染会导致输出文件包含未替换的占位符，
> 从而在下次执行时产生大量虚假变更，破坏幂等性。

### 4.3 写入

- 覆盖写入本地项目
- 模板新增而本地不存在的文件要创建
- 模板已删除的文件只提示用户，不自动删除

## 步骤 5：处理 merged 文件（AI 智能合并）

先渲染出模板最新版（同步骤 4 的语言选择和占位符渲染规则），再读取本地当前文件。

**如果本地文件不存在**（首次安装），直接写入渲染后的模板，跳过合并。

如果本地文件存在，对比渲染后的模板与本地文件：
- 识别**模板标准部分**（结构、格式、通用规则）和**用户定制**（项目特定内容、已填充的 TODO 等）
- 模板标准部分 → 更新到最新版
- 用户定制 → 保留
- 模板新增部分 → 插入适当位置
- 模板已删除部分 → 提示用户，默认保留

**合并原则**：
- 有疑问时保留用户内容
- 不静默删除用户添加的内容

## 步骤 6：处理 ejected 文件

- **本地文件已存在**：不触碰（ejected = 用户完全拥有）
- **本地文件不存在**（首次安装）：从模板渲染并写入一份，后续更新跳过

## 步骤 7：更新 collaborator.json

更新 `templateVersion` 为模板源当前版本（步骤 2 记录的 commit SHA）。
除非用户明确要求迁移模板目录，否则保持 `templateSource` 不变。

## 步骤 8：验证与输出报告

**幂等性检查**：对已经是最新状态的项目执行此命令，预期产生极少或零文件变更。
如果 managed 文件变更数量超出预期，在提交前暂停，用 `git diff` 抽查变更方向是否正确
（正确方向：模板新内容 → 本地；错误方向：将已渲染内容退化回占位符）。

输出报告后**停止**，不要对项目做其他更改。
