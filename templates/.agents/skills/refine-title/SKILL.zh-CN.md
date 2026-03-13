---
name: refine-title
description: >
  深度分析 Issue 或 PR 内容，并将其标题重构为 Conventional Commits 格式。
  当用户要求优化标题时触发。参数：issue 或 PR 编号。
---

# 重构标题

基于深度内容分析，将指定 Issue 或 PR 的标题重构为 Conventional Commits 格式。

## 执行流程

### 1. 识别目标并获取信息

尝试判断 ID 是 Issue 还是 PR：

```bash
# 先尝试 Issue
gh issue view <id> --json number,title,body,labels,state

# 如果未找到或是 PR
gh pr view <id> --json number,title,body,labels,state,files
```

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
- 保持简洁（不超过 50 字符），英文祈使语气，末尾无句号

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

```bash
# 对于 Issue
gh issue edit <id> --title "<new-title>"

# 对于 PR
gh pr edit <id> --title "<new-title>"
```

## 优势

本技能的优势：
1. **修复误导性标题**：即使原始标题是"Help me"，也能读取 body 并生成合适的标题，如 `fix(core): resolve startup error`
2. **精确 scope**：通过分析 PR 文件变更，可以自动推断正确的 scope，无需手动指定

## 注意事项

- subject 应从 body 内容提取，而不是从原始标题重新格式化
- 如果 body 为空或信息不足，向用户询问澄清
- 遵循项目对 scope 命名的约定
