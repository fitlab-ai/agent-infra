# 快速入门：多 AI 协作

本指南将带你了解如何在项目中协同使用多个 AI 编程助手。

## 前提条件

- 至少安装一个 AI 编程工具（Claude Code、Codex CLI、Gemini CLI 或 OpenCode）
- 项目已设置 `.agents/` 目录（本项目已就绪）
- 熟悉你的项目代码库

## Git Hook 配置

在依赖模板中的 Git hook 链路前，先启用共享 hooks 路径：

```bash
git config core.hooksPath .github/hooks
```

这样 Git 才会调用同步到 `.github/hooks/` 下的 hook，包括 `pre-commit` 和 `check-version-format.sh`。

## 外部模板与 Skill

如果团队维护私有平台模板或共享自定义 skill，可在 `.agents/.airc.json` 中配置本地源：

```json
{
  "templates": {
    "sources": [{ "type": "local", "path": "~/private-templates" }]
  },
  "skills": {
    "sources": [{ "type": "local", "path": "~/private-skills" }]
  }
}
```

内置模板优先级高于外部模板。多个外部模板源之间，后面的 source 覆盖前面的 source，`update-agent-infra` 会在 `templateSources.conflicts` 中报告冲突。外部模板和 skill 可能包含可执行脚本，只使用可信本地路径。

## 创建第一个任务

1. 将任务模板复制到活跃工作区：

```bash
cp .agents/templates/task.md .agents/workspace/active/task-001.md
```

2. 填写任务元数据：

```yaml
id: task-001
type: feature          # feature | bugfix | refactor | docs | review
status: open           # open | in-progress | review | blocked | completed
assigned_to: claude    # claude | codex | gemini | opencode | human
```

3. 在文档正文中描述任务。

## 不同阶段使用不同 AI

### 阶段 1：分析（推荐：Claude Code）

```bash
# 启动 Claude Code 并让它分析任务
claude

# 示例提示：
# "分析 task-001。探索代码库并识别所有需要修改的文件。
#  将你的发现更新到任务中。"
```

Claude Code 擅长代码库探索和理解文件间的复杂关系。

### 阶段 2：设计（推荐：Claude Code 或 Gemini CLI）

```bash
# 继续使用 Claude Code 或切换到 Gemini CLI 处理大型代码库
gemini

# 示例提示：
# "基于 .agents/workspace/active/task-001.md 中的分析结果，
#  创建技术设计方案。定义接口并概述实现思路。"
```

### 阶段 3：实现（推荐：Codex CLI 或 OpenCode）

```bash
# 切换到 Codex CLI 进行实现
codex

# 示例提示：
# "实现 .agents/workspace/active/task-001.md 中描述的变更。
#  遵循设计部分。为此工作创建新分支。"
```

### 阶段 4：审查（推荐：Claude Code）

```bash
# 切换回 Claude Code 进行审查
claude

# 示例提示：
# "审查 feature-xxx 分支上的实现。
#  检查正确性、代码风格和最佳实践。
#  创建审查报告。"
```

## 常见场景

### 缺陷修复

1. **复现和分析**（Claude Code）：识别根本原因。
2. **实现修复**（Codex CLI / OpenCode）：编写修复代码和测试。
3. **审查**（Claude Code）：验证修复是否正确和完整。
4. **提交**：创建包含缺陷修复描述的 PR。

```bash
# 快速缺陷修复工作流
cp .agents/templates/task.md .agents/workspace/active/bugfix-001.md
# 编辑任务，然后：
# 1. 使用 Claude Code 分析
# 2. 使用 Codex/OpenCode 修复
# 3. 使用 Claude Code 审查
```

### 代码审查

1. **加载上下文**（Claude Code）：阅读 PR 差异和相关文件。
2. **审查**（Claude Code）：检查逻辑、风格、测试和边界情况。
3. **报告**：从模板生成审查报告。

```bash
cp .agents/templates/review-report.md .agents/workspace/active/review-pr-42.md
# 使用 Claude Code 填写审查内容
```

### 重构

1. **分析范围**（Claude Code / Gemini CLI）：映射所有受影响区域。
2. **设计**（Claude Code）：规划重构方案。
3. **实现**（Codex CLI / OpenCode）：执行重构。
4. **验证**（Claude Code）：确保没有回归问题，运行测试。

```bash
cp .agents/templates/task.md .agents/workspace/active/refactor-001.md
# 按照 .agents/workflows/refactoring.yaml 中的重构工作流执行
```

## 创建交接文档

在 AI 工具之间切换时，创建交接文档：

```bash
cp .agents/templates/handoff.md .agents/workspace/active/handoff-task-001-phase2.md
```

填写：
- 已完成的内容
- 代码当前状态
- 接下来需要做什么
- 任何阻塞项或关注点

接收方 AI 应首先阅读此文档以快速了解上下文。

## 最佳实践

### 1. 每个阶段一个 AI

不要让多个 AI 同时处理相同的文件。遵循顺序工作流：分析、设计、实现、审查、修复、提交。

### 2. 始终创建交接文档

即使你在 AI 之间快速切换，简短的交接说明也能节省时间并防止上下文丢失。

### 3. 选择合适的工具

- 复杂分析？使用 Claude Code 或 Gemini CLI。
- 直接的实现工作？使用 Codex CLI 或 OpenCode。
- 大文件审查？使用 Gemini CLI。

### 4. 保持任务小而精

将大任务拆分为更小的、定义明确的子任务。每个子任务应该能在单次 AI 会话中完成。

### 5. 版本控制你的进度

频繁提交。每个阶段完成都是一个好的提交点。这样在需要时可以轻松回滚。

### 6. 更新任务状态

在阶段之间转换时，始终更新任务的 `status`、`current_step` 和 `assigned_to` 字段。

### 7. 审核 AI 输出

在提交之前始终审核 AI 的产出。AI 工具是辅助工具，不是自主代理。
