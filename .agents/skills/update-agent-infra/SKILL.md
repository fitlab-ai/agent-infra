---
name: update-agent-infra
description: "更新项目 AI 协作配置"
---

# 更新项目

## 执行约束

1. **确定性步骤脚本化**：managed / ejected 文件处理、注册表同步、配置更新
   全部由 `sync-templates.js` 脚本执行，不得逐文件手工处理。
   脚本保证原子性和幂等性。

2. **禁止委托子代理**：阶段 B（merged 文件智能合并）必须在主会话中直接执行，
   不得委托给子代理。子代理上下文有限，容易误判文件内容。

## 阶段 A：运行同步脚本（确定性）

执行以下命令，一次性处理所有确定性步骤：

```bash
node .agents/skills/update-agent-infra/scripts/sync-templates.js
```

脚本读取 `.agents/.airc.json`，并通过 npm 自动定位已安装的 `@fitlab-ai/agent-infra/templates/` 目录。同步前会合并 `templates.sources` 中配置的外部模板源；相同文件以内置模板为准，多个外部源之间后者覆盖前者，冲突会写入报告。然后自动完成：
- 检测模板源版本
- 同步文件注册表（`defaults.json` → `.agents/.airc.json`）
- 处理所有 managed 文件（语言选择 → 排除 merged/ejected → 占位符渲染 → 覆盖写入）
- 处理 ejected 文件（仅首次安装时创建）
- 更新 `.agents/.airc.json`（`templateVersion`、文件列表）

脚本输出 JSON 到 stdout，解析并记录报告内容。

**关键字段**：
- `error`：错误信息（如非空则停止并报告）
- `templateVersion`：模板源当前版本
- `templateRoot`：模板文件根目录绝对路径
- `templateSources.conflicts`：外部模板源冲突列表；报告中必须显式展示，说明哪些文件因内置模板或后续外部源获胜而被忽略
- `managed.written` / `managed.created`：已更新/新建的 managed 文件
- `merged.pending`：需要 AI 处理的 merged 文件列表
  - 每项包含 `target`（项目中的目标路径）和 `template`（模板根目录下的相对路径）
- `registryAdded`：新增的文件注册条目
- `selfUpdate`：是否为自更新模式
- `configUpdated`：`.agents/.airc.json` 是否已更新

## 阶段 B：处理 merged 文件（AI 智能合并）

根据报告中 `merged.pending` 列表，逐个文件处理。对于每个条目：

1. 从 `<templateRoot>/<template>` 读取模板文件
2. 渲染占位符：将双花括号包裹的 `project` 和 `org` 占位符替换为 .agents/.airc.json 中的实际值
3. 读取本地当前文件（`<项目根>/<target>`）

**如果本地文件不存在**（首次安装），直接写入渲染后的模板，跳过合并。

如果本地文件存在，执行以下合并算法：

### B.1 以模板为基底

使用渲染后的新模板作为输出的基底。模板代表最佳实践，其结构和内容具有权威性。

### B.2 从本地文件萃取增量

扫描本地文件，找出比模板内容"多"的部分（用户增量）：
- **已填充的 TODO**：模板中的 TODO 占位符在本地文件中被替换为实际内容
- **新增段落/章节**：本地文件中存在但模板中不存在的内容
- **扩展内容**：对模板现有内容的补充说明

### B.3 合入新模板

将萃取的增量合入新模板的适当位置：
- 已填充的 TODO → 替换对应的 TODO 占位符
- 新增段落 → 插入最相关的位置
- 扩展内容 → 合入对应章节

### B.4 通读验证

整体检查合并后文件的逻辑完整性，确保：
- 增量合入位置正确
- 无重复内容
- 文档结构连贯

### B.5 冲突处理

当本地文件修改过的内容与模板新内容冲突时：
- 保留模板版本（模板权威性原则）
- 在报告中提示用户该冲突，以便用户确认

### B.6 残余 TODO 提示

合并完成后，如果仍有模板 TODO 未被本地文件的内容填充，在报告中提示用户。

## 阶段 C：验证与输出报告

**方向检查**：用 `git diff` 抽查变更方向是否正确。
正确方向：模板新内容 → 本地；错误方向：将已渲染内容退化回占位符。
如果发现错误方向的变更，暂停并排查原因。

### 自身更新检测

检查 `git diff` 中是否包含 `.agents/skills/update-agent-infra/SKILL.md` 的变更。
如果该文件在本次更新中被修改，在报告末尾输出以下警告：

```
⚠ update-agent-infra 技能自身已更新。
  建议再次执行 /update-agent-infra 以确保所有新逻辑生效。
```

> **原因**：本次执行使用的是旧版技能逻辑，新版技能可能包含额外的处理步骤。
> 再次执行可确保新逻辑完整应用。
> 用户也可以在执行前先运行 `ai update` 来预先更新技能文件，避免需要两次执行。

### 输出报告

基于脚本报告和 merged 合并结果，输出完整的更新报告，包括：
- 模板版本变更
- 文件注册表新增条目
- 外部模板源冲突（如 `templateSources.conflicts` 非空，必须逐项列出）
- managed 文件变更明细（已更新、新建、跳过的 merged 文件）
- merged 文件合并结果（冲突、残余 TODO）
- ejected 文件处理
- 自身更新检测结果

如有变更需要提交，追加：

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

```
下一步 - 提交代码：
  - Claude Code / OpenCode：/commit
  - Gemini CLI：/agent-infra:commit
  - Codex CLI：$commit
```

输出报告后**停止**，不要对项目做其他更改。
