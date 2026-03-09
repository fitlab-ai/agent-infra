# 多 AI 协作指南

本项目支持多个 AI 编程助手协同工作，包括 Claude Code、OpenAI Codex CLI、Gemini CLI、Cursor 等。

## 双配置架构

不同的 AI 工具从不同位置读取配置：

| AI 工具 | 主要配置 | 备选配置 |
|---------|---------|---------|
| Claude Code | `.claude/`（CLAUDE.md、commands/、settings/） | - |
| OpenAI Codex CLI | `AGENTS.md` | - |
| Gemini CLI | `AGENTS.md` | - |
| Cursor | `.cursorrules` 或 `.cursor/rules/` | `AGENTS.md` |
| 其他 AI 工具 | `AGENTS.md` | 项目 README |

- **Claude Code** 使用专属的 `.claude/` 目录存放项目指令、斜杠命令和设置。
- **所有其他 AI 工具** 共享项目根目录下的统一 `AGENTS.md` 文件作为指令来源。

这种双配置方式确保每个 AI 工具都能获得适当的项目上下文，而无需重复维护。

## 目录结构

```
.agents/                        # AI 协作配置（版本控制）
  README.md                     # 本文件（英文）
  README.zh-CN.md               # 中文版本
  QUICKSTART.md                 # 快速入门指南
  QUICKSTART.zh-CN.md           # 快速入门指南（中文）
  templates/                    # 任务和文档模板
    task.md                     # 任务模板
    handoff.md                  # AI 间交接模板
    review-report.md            # 代码审查报告模板
  workflows/                    # 工作流定义
    feature-development.yaml    # 功能开发工作流
    bug-fix.yaml                # 缺陷修复工作流
    code-review.yaml            # 代码审查工作流
    refactoring.yaml            # 重构工作流

.ai-workspace/                  # 运行时工作区（已被 git ignore）
  active/                       # 当前活跃任务
  blocked/                      # 被阻塞的任务
  completed/                    # 已完成的任务
  logs/                         # 协作日志

.claude/                        # Claude Code 专属配置
  CLAUDE.md                     # Claude 项目指令
  commands/                     # 斜杠命令
  settings/                     # Claude 设置
```

## 协作模型

多 AI 协作遵循结构化工作流：

```
1. 分析    -->  2. 设计    -->  3. 实现
                                    |
6. 提交  <--  5. 修复问题  <--  4. 审查
```

### 阶段详情

1. **分析** - 理解问题，探索代码库，识别受影响的区域。
2. **设计** - 创建技术方案，定义接口，概述实现思路。
3. **实现** - 按照设计方案编写代码。
4. **审查** - 审查实现的正确性、代码风格和最佳实践。
5. **修复问题** - 处理审查阶段的反馈意见。
6. **提交** - 最终确认变更，编写提交信息，创建 PR。

### 任务交接

当一个 AI 完成某个阶段后，会生成一份**交接文档**（参见 `.agents/templates/handoff.md`），为下一个 AI 提供上下文。这确保了不同工具之间的工作连续性。

## AI 工具能力对比

每个 AI 工具有不同的优势，请据此分配任务：

| 能力 | Claude Code | Codex CLI | Gemini CLI | Cursor |
|-----|-------------|-----------|------------|--------|
| 代码库分析 | 优秀 | 良好 | 优秀 | 良好 |
| 代码审查 | 优秀 | 良好 | 良好 | 一般 |
| 代码实现 | 良好 | 优秀 | 良好 | 优秀 |
| 大上下文处理 | 良好 | 一般 | 优秀 | 良好 |
| 重构 | 良好 | 良好 | 良好 | 优秀 |
| 文档编写 | 优秀 | 良好 | 良好 | 一般 |

### 推荐分配

- **分析和审查** - Claude Code（推理能力强，探索全面）
- **代码实现** - Codex CLI 或 Cursor（代码生成快，内联编辑）
- **大上下文任务** - Gemini CLI（大上下文窗口，适合跨文件分析）
- **快速编辑** - Cursor（IDE 集成，快速迭代）

## 快速入门

1. **阅读快速入门指南**：参见 `QUICKSTART.zh-CN.md` 获取分步说明。
2. **创建任务**：将 `.agents/templates/task.zh-CN.md` 复制到 `.ai-workspace/active/`。
3. **分配给 AI**：更新任务元数据中的 `assigned_to` 字段。
4. **执行工作流**：按照 `.agents/workflows/` 中相应的工作流执行。
5. **交接**：切换 AI 时，从模板创建交接文档。

## 常见问题

### Q：我需要单独配置每个 AI 工具吗？

不需要。Claude Code 从 `.claude/CLAUDE.md` 读取配置，其他所有工具从 `AGENTS.md` 读取。你只需维护两个配置源。

### Q：任务如何在 AI 工具之间传递？

通过存储在 `.ai-workspace/` 中的交接文档。每份交接文档包含上下文、进度和后续步骤，让接收方 AI 能无缝接续。

### Q：如果某个 AI 工具不支持 AGENTS.md 怎么办？

你可以将相关指令复制到该工具的原生配置格式中，或直接粘贴到提示词中。

### Q：多个 AI 可以同时处理同一个任务吗？

不建议。工作流模型是顺序的——每个阶段一个 AI。并行工作应在不同的任务或不同的分支上进行。

### Q：运行时文件存储在哪里？

在 `.ai-workspace/` 中，该目录已被 git ignore。只有 `.agents/` 中的模板和工作流定义受版本控制。
