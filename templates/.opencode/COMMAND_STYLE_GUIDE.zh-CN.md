# 命令编写风格指南

本指南定义了 `.opencode/commands/` 目录中 OpenCode 命令文件的编写规范。

## 文件格式

每个命令文件使用带 YAML 前置元数据的 Markdown 格式：

```markdown
---
description: 简要描述
agent: general
subtask: false
---

命令指令内容。
```

### 前置元数据字段

| 字段 | 必需 | 说明 |
|------|------|------|
| `description` | 是 | 一行摘要（80 字符以内） |
| `agent` | 是 | 除非有专门代理，否则为 `general` |
| `subtask` | 是 | 顶层命令为 `false` |

## 可执行命令 vs 代码块

### 使用 `!` 前缀标记必须执行的命令

```markdown
!date -u +"%Y-%m-%dT%H:%M:%SZ"
!git status --short
!gh issue view 123 --json number,title,body
```

`!` 前缀告诉 OpenCode 直接运行该命令。适用于：
- 获取动态信息（时间戳、git 状态）
- 执行操作（创建文件、调用 API）
- 运行构建/测试命令

### 使用 markdown 代码块展示说明性示例

````markdown
预期输出格式：
```
Task ID: TASK-20260101-120000
Status: active
```
````

代码块不会被执行。适用于：
- 展示预期输出格式
- 记录模板
- 说明 AI 应遵循的模式

## 参数处理

### 位置参数

通过 `$ARGUMENTS` 引用：

```markdown
从 `$ARGUMENTS` 中解析任务 ID。
```

### 验证

始终在早期验证必需参数：

```markdown
如果 `$ARGUMENTS` 为空，回复：
"请提供任务 ID。示例：/check-task TASK-20260101-120000"
然后 STOP。
```

## 时间戳处理

**绝对不要**硬编码日期或年份。

正确做法：
```markdown
!date -u +"%Y-%m-%dT%H:%M:%SZ"
```

错误做法：
```markdown
将日期设为 2026-03-06。
```

## GitHub API 路径

**始终**使用 `{owner}/{repo}` 占位符。动态解析：

```markdown
!gh api repos/{owner}/{repo}/dependabot/alerts/$ARGUMENTS
```

获取 owner/repo：
```markdown
!gh repo view --json owner,name -q '.owner.login + "/" + .name'
```

## 步骤编号和可读性

### 使用编号标记顺序操作

```markdown
## 步骤

1. **验证输入** - 检查是否提供了任务 ID。

2. **读取任务文件** - 查找并读取 task.md 文件。

3. **更新状态** - 修改任务元数据。
```

### 使用粗体标记步骤标题

每个步骤应有清晰的粗体标题，后跟描述。

### 保持步骤原子化

每个步骤只做一件事。如果步骤太复杂，拆分为子步骤。

## 错误处理模式

### 在操作前检查前置条件

```markdown
1. **验证任务存在**

按以下顺序搜索任务文件：
- `.ai-workspace/active/{task-id}/task.md`
- `.ai-workspace/blocked/{task-id}/task.md`
- `.ai-workspace/completed/{task-id}/task.md`

如果未找到，回复：
"任务 {task-id} 不存在，请检查任务 ID。"
然后 STOP。
```

### 清晰地报告错误

```markdown
如果命令失败，报告：
- 出了什么问题
- 可能的原因
- 建议的后续步骤

不要静默继续。
```

## 常见模式

### 任务文件查找模式

```markdown
按以下顺序搜索任务：
1. `.ai-workspace/active/{task-id}/task.md`
2. `.ai-workspace/blocked/{task-id}/task.md`
3. `.ai-workspace/completed/{task-id}/task.md`
```

### 状态更新模式

```markdown
更新 `task.md` YAML 前置元数据：
- `current_step`: {步骤名}
- `assigned_to`: opencode
- `updated_at`: {通过 date 命令获取的当前时间戳}
```

### 下一步建议模式

```markdown
**下一步：**
使用 `/plan-task {task-id}` 设计技术方案。
```

## 反模式

### 不要

- 硬编码日期、年份或时间戳
- 在 API 路径中硬编码仓库 owner/name
- 跳过参数验证
- 未经用户确认就自动提交
- 使用特定工具语法（如 Claude 的 Read/Edit/Write 工具名）
- 引用特定技术栈的命令但不加 TODO 标记
- 在命令文件中使用 emoji（保持专业）
- 写过长的步骤——应该拆分

### 要

- 对所有可执行命令使用 `!` 前缀
- 在继续之前验证参数
- 提供清晰的错误消息
- 在错误条件后包含 "STOP"
- 保持命令简洁且易于浏览
- 对项目特定的值使用占位符
- 对技术栈特定的部分添加 TODO 标记

## 技术栈无关的命令

对于依赖项目技术栈的命令（构建工具、测试运行器、包管理器），使用 TODO 标记：

```markdown
3. **运行测试**

<!-- TODO: Replace with your project's test command -->
!npm test
```

这告诉用户需要根据自己的项目定制该命令。

## 命令审查清单

提交新命令前，请验证：

- [ ] 前置元数据包含 `description`、`agent` 和 `subtask`
- [ ] 所有可执行命令使用 `!` 前缀
- [ ] 所有说明性示例使用代码块（无 `!`）
- [ ] 参数已验证，有清晰的错误消息
- [ ] 时间戳动态生成
- [ ] GitHub API 路径使用 `{owner}/{repo}` 占位符
- [ ] 步骤已编号且有粗体标题
- [ ] 错误情况使用 "STOP" 指令处理
- [ ] 无硬编码的日期、仓库名或工具特定引用
- [ ] 技术栈特定的部分有 TODO 标记
- [ ] 已创建英文和中文两个版本
- [ ] 命令简洁——无多余的描述
