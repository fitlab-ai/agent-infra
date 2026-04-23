---
name: refine-title
description: "重构 Issue/PR 标题为 Conventional Commits 格式"
---

# 重构标题

基于深度内容分析，将指定 Issue 或 PR 的标题重构为 Conventional Commits 格式。

## 执行流程

### 1. 识别目标并获取信息

执行前先读取 `.agents/rules/issue-pr-commands.md`，并按其中的前置步骤完成认证和代码托管平台检测。

尝试判断 ID 是 Issue 还是 PR：
- 先按规则文件中的“读取 Issue”命令获取 Issue 信息
- 如果未找到或目标实际为 PR，再按规则文件中的“读取 PR”命令获取 PR 信息

### 2. 分析内容

基于获取的数据：

**确定 Type**：
- 阅读 body 以寻找变更类型指示
- 检查标签（例如 `type: bug` -> `fix`，`type: feature` -> `feat`）
- 如果是 PR，分析文件（仅文档变更 -> `docs`，仅测试 -> `test`）

**确定 Scope**：
- 阅读 body 以寻找模块提及
- 检查标签中的模块指示
- 如果是 PR，分析文件路径以推断受影响的模块

**生成 Subject**：
- **忽略原始标题**（避免偏见）- 从 body 中提取核心意图
- 保持简洁（不超过 50 字符），使用内容原始语言（中文内容用中文，英文内容用英文），末尾无句号

### 3. 展示建议

```
Issue/PR #{id} 分析结果：

当前标题：{原始标题}
--------------------------------------------------
分析：
- 意图：{从 body 提取的一行摘要}
- 类型：{type}（依据：{依据}）
- 范围：{scope}（依据：{依据}）
--------------------------------------------------
建议标题：{type}({scope}): {subject}
```

询问用户："是否应用此标题？(y/n)"

### 4. 应用修改

如果用户确认：
- 对于 Issue：按 `.agents/rules/issue-pr-commands.md` 中的 “Issue 更新” 命令设置标题
- 对于 PR：按 `.agents/rules/issue-pr-commands.md` 中的 “PR 更新” 命令设置标题

标题修改需要写权限，按 `.agents/rules/issue-pr-commands.md` 与 `.agents/rules/issue-sync.md` 中的权限降级规则执行；无权限时跳过修改操作并告知用户。

### 5. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了 `customTools`，读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`{name}` 替换为技能名，`&#123;project&#125;` 替换为项目名）。

如果修改了 Issue 标题，提示无需额外同步命令；后续按任务当前阶段继续执行对应工作流技能。

如果修改了 PR 标题，提示 `create-pr` 已内联发布 reviewer 摘要，无需额外同步命令；后续按任务当前阶段继续执行对应工作流技能。

如果因权限不足跳过了标题修改，额外提示用户建议标题仍可手动应用到代码托管平台页面。

## 优势

本技能的优势：
1. **修复误导性标题**：即使原始标题是"Help me"，也能读取 body 并生成合适的标题，如 `fix(core): 修复启动错误` 或 `fix(core): resolve startup error`
2. **精确 scope**：通过分析 PR 文件变更，可以自动推断正确的 scope，无需手动指定

## 注意事项

- subject 应从 body 内容提取，而不是从原始标题重新格式化
- 如果 body 为空或信息不足，向用户询问澄清
- 遵循项目对 scope 命名的约定
