# 多 AI 协作指南

本项目支持多个 AI 编程助手协同工作，包括 Claude Code、OpenAI Codex CLI、Gemini CLI、OpenCode 等。

## 双配置架构

不同的 AI 工具从不同位置读取配置：

| AI 工具 | 主要配置 | 备选配置 |
|---------|---------|---------|
| Claude Code | `.claude/`（CLAUDE.md、commands/、settings.json） | - |
| OpenAI Codex CLI | `AGENTS.md` | - |
| Gemini CLI | `AGENTS.md` | - |
| OpenCode | `AGENTS.md` | - |
| 其他 AI 工具 | `AGENTS.md` | 项目 README |

- **Claude Code** 使用专属的 `.claude/` 目录存放项目指令、斜杠命令和设置。
- **所有其他 AI 工具** 共享项目根目录下的统一 `AGENTS.md` 文件作为指令来源。

这种双配置方式确保每个 AI 工具都能获得适当的项目上下文，而无需重复维护。

## 目录结构

```
.agents/                        # AI 协作配置（版本控制）
  README.md                     # 协作指南
  QUICKSTART.md                 # 快速入门指南
  templates/                    # 任务和文档模板
    task.md                     # 任务模板
    handoff.md                  # AI 间交接模板
    review-report.md            # 代码审查报告模板
  workflows/                    # 工作流定义
    feature-development.yaml    # 功能开发工作流
    bug-fix.yaml                # 缺陷修复工作流
    code-review.yaml            # 代码审查工作流
    refactoring.yaml            # 重构工作流
  workspace/                    # 运行时工作区（已被 git ignore）
    active/                     # 当前活跃任务
    blocked/                    # 被阻塞的任务
    completed/                  # 已完成的任务
    logs/                       # 协作日志

.claude/                        # Claude Code 专属配置
  CLAUDE.md                     # Claude 项目指令
  commands/                     # 斜杠命令
  settings.json                 # Claude 设置
```

## 协作模型

多 AI 协作遵循结构化工作流：

1. 分析
2. 设计
3. 实现
4. 审查
5. 修复问题
6. 提交

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

| 能力 | Claude Code | Codex CLI | Gemini CLI | OpenCode |
|-----|-------------|-----------|------------|----------|
| 代码库分析 | 优秀 | 良好 | 优秀 | 良好 |
| 代码审查 | 优秀 | 良好 | 良好 | 良好 |
| 代码实现 | 良好 | 优秀 | 良好 | 优秀 |
| 大上下文处理 | 良好 | 一般 | 优秀 | 一般 |
| 重构 | 良好 | 良好 | 良好 | 良好 |
| 文档编写 | 优秀 | 良好 | 良好 | 良好 |

### 推荐分配

- **分析和审查** - Claude Code（推理能力强，探索全面）
- **代码实现** - Codex CLI 或 OpenCode（代码生成快，命令式工作流顺手）
- **大上下文任务** - Gemini CLI（大上下文窗口，适合跨文件分析）
- **命令式迭代** - OpenCode（适合按工作流连续推进）

## 快速入门

1. **阅读快速入门指南**：参见 `QUICKSTART.md` 获取分步说明。
2. **创建任务**：将 `.agents/templates/task.md` 复制到 `.agents/workspace/active/`。
3. **分配给 AI**：更新任务元数据中的 `assigned_to` 字段。
4. **执行工作流**：按照 `.agents/workflows/` 中相应的工作流执行。
5. **交接**：切换 AI 时，从模板创建交接文档。

## Label 规范

本项目的协作 labels 按以下前缀分类，各前缀有明确的适用范围：

| Label 前缀 | Issue | PR | 说明 |
|---|---|---|---|
| `type:` | — | Yes | Issue 优先使用平台原生的类型/分类字段；PR 无原生类型字段时，通过 `type:` label 驱动 changelog 和分类 |
| `status:` | Yes | — | PR 有自身状态流转（Open / Draft / Merged / Closed）；Issue 使用 `status:` label 标记等待反馈、已确认等项目管理状态 |
| `in:` | Yes | Yes | Issue 和 PR 均可按模块筛选 |

默认 GitHub 配置下，可使用 `/init-labels` 命令一次性创建标准 labels。

## 私有平台扩展

如需将 agent-infra 接入私有代码托管平台：

1. 在 `.agents/.airc.json` 中把 `platform.type` 设为稳定标识，例如 `my-platform`。
2. 以 `.agents/rules/` 下已生成的规则文件为起点，改写为你的平台 CLI 或 API 调用，同时保持运行时文件名不变。
3. 将这些自定义规则文件加入 `.agents/.airc.json` 的 `files.ejected`，避免后续执行 `agent-infra update` 时被覆盖。
4. 如果你维护的是模板源码分支或私有 fork，需要先补齐对应的 `.{platform}.` 模板变体，再把该平台标识加入模板同步逻辑。
5. 在正式推广前，先用一个测试任务完整验证工作流和 gate 校验。

## 外部模板与 Skill 源

团队可以在 `.agents/.airc.json` 中配置外部模板源和共享 skill 源，用于接入公司内部平台模板、私有规则和团队维护的自定义 skill：

```json
{
  "templates": {
    "sources": [
      { "type": "local", "path": "~/company-templates" }
    ]
  },
  "skills": {
    "sources": [
      { "type": "local", "path": "~/company-skills" }
    ]
  }
}
```

模板源优先级为内置模板优先，外部模板只做补充；多个外部模板源之间，后面的 source 覆盖前面的 source。同步报告会在 `templateSources.conflicts` 中列出被忽略的同名文件。外部模板和 skill 可能包含会被 AI 工作流执行的脚本，只配置可信路径。

## 自定义 Skills

项目可以在内置任务工作流之外增加自己的 skill。

### 项目内本地 skill

在 `.agents/skills/<name>/` 下创建目录，并添加 `SKILL.md`：

```text
.agents/skills/
  enforce-style/
    SKILL.md
    reference/
      style-guide.md
```

推荐 frontmatter：

```yaml
---
name: enforce-style
description: "在代码审查前应用团队风格规范"
args: "<task-id>"   # 可选
---
```

新增或修改自定义 skill 后，再执行一次 `update-agent-infra`。同步过程会自动检测非内置 skill，并为 Claude Code、Gemini CLI、OpenCode 生成对应命令。

### 共享 skill 源

如需复用团队集中维护的 skill，可在 `.agents/.airc.json` 中配置：

```json
{
  "skills": {
    "sources": [
      { "type": "local", "path": "~/company-skills" }
    ]
  }
}
```

每个 source 都应镜像 `.agents/skills/` 的目录结构，并在每个 skill 目录根部提供 `SKILL.md`。

### 同步行为

- `.agents/skills/` 中手动创建的项目自定义 skill 不会被 managed 文件清理删除
- 多个 source 按声明顺序应用；后面的自定义 source 会覆盖前面的自定义 source 文件
- 对于仍存在于配置 source 中的 skill，如果源里删掉文件，下次同步时会删除本地对应残留文件
- 自定义 source 不能覆盖内置 skill；如果与内置 skill 同名，会跳过该 source skill
- 如果项目必须接管某个内置 skill 或命令，请使用 `files.ejected`

## Skill 编写规范

编写或维护 `.agents/skills/*/SKILL.md` 及其模板时，步骤编号遵循以下规则：

1. 顶级步骤使用连续整数：`1.`、`2.`、`3.`。
2. 只有父步骤下的从属动作才使用子步骤：`1.1`、`1.2`、`2.1`。
3. 同一步中的从属选项、条件分支或并列可能性使用 `a`、`b`、`c` 标记；仅用于步骤内部的子项展开，不用于命名独立的决策路径或输出模板。
4. 不要使用 `1.5`、`2.5` 这类中间编号；如新增独立步骤，应整体顺延后续编号。
5. 调整编号时，必须同步更新文中的步骤引用，确保说明、命令和检查点一致。
6. 长 bash 脚本应从 SKILL.md 提取到同级 `scripts/` 目录中，SKILL.md 只保留单行调用（如 `bash .agents/skills/<skill>/scripts/<script>.sh`）和对脚本职责的概要说明。
7. 在 SKILL.md 及其 `reference/` 模板中，如需为独立的条件分流、决策路径或输出模板命名，统一使用“场景”命名（例如使用“场景 A”）。

### SKILL.md 体积控制

- SKILL.md 正文尽可能精简，把详细规则、长模板和大段脚本拆分到同级 `reference/` 或 `scripts/` 目录。
- 声明式配置统一放在同级 `config/` 目录，例如 `config/verify.json`。
- 骨架中使用明确导航，例如：`执行此步骤前，先读取 reference/xxx.md。`
- 长脚本继续放在 `scripts/` 目录，优先执行脚本而不是内联大段 bash。

## 完成校验

对会产生结构化产物或任务状态变更的 skill，统一在结束前运行完成校验：

```bash
node .agents/scripts/validate-artifact.js gate <skill-name> <task-dir> [artifact-file] [--format json|text]
```

- 每个 skill 在自己的 `config/verify.json` 中声明需要检查的事项
- 如果 skill 还会展示“下一步”提示，必须先通过完成校验，再输出这些指引
- 面向用户展示最终校验结果时，优先使用 `--format text` 输出可读摘要，而不是原始 JSON
- 共享逻辑集中在 `.agents/scripts/validate-artifact.js`，不要把详细校验规则重新塞回 SKILL.md
- 在回复中保留当次校验输出作为当次验证输出；没有当次校验输出，不得声明完成

## 常见问题

### Q：我需要单独配置每个 AI 工具吗？

不需要。Claude Code 从 `.claude/CLAUDE.md` 读取配置，其他所有工具从 `AGENTS.md` 读取。你只需维护两个配置源。

### Q：任务如何在 AI 工具之间传递？

通过存储在 `.agents/workspace/` 中的交接文档。每份交接文档包含上下文、进度和后续步骤，让接收方 AI 能无缝接续。

### Q：如果某个 AI 工具不支持 AGENTS.md 怎么办？

你可以将相关指令复制到该工具的原生配置格式中，或直接粘贴到提示词中。

### Q：多个 AI 可以同时处理同一个任务吗？

不建议。工作流模型是顺序的——每个阶段一个 AI。并行工作应在不同的任务或不同的分支上进行。

### Q：运行时文件存储在哪里？

在 `.agents/workspace/` 中，该目录已被 git ignore。只有 `.agents/` 中的模板和工作流定义受版本控制。
