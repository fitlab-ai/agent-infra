---
name: init-milestones
description: "初始化仓库的 milestones 体系"
---

# 初始化 milestones

一次性初始化仓库的标准 milestones 体系。

## 执行流程

### 1. 验证前置条件

确认以下条件成立：
- 执行前先读取 `.agents/rules/label-milestone-setup.md`
- 按其中的认证命令验证平台访问能力

如果任一条件失败，停止并输出对应错误。

### 2. 运行初始化脚本

执行以下命令，完成整套里程碑初始化流程：

```bash
bash .agents/skills/init-milestones/scripts/init-milestones.sh "$ARGUMENTS"
```

脚本与 `.agents/rules/label-milestone-setup.md` 共同负责：
- 创建并清理临时工作目录
- 检测是否传入 `--history`
- 按“最新 `v*` Git tag → `package.json` → 默认 `0.1.0`”解析版本基线
- 使用平台对应的 milestones 查询命令读取当前里程碑
- 构建目标里程碑集合，并且只创建缺失标题
- 输出最终执行摘要

### 3. 标准里程碑定义

按固定描述创建以下里程碑：
- `General Backlog`：`All unsorted backlogged tasks may be completed in a future version.`（state=`open`）
- `{major}.{minor}.x`：`Issues that we want to resolve in {major}.{minor} line.`（state=`open`）
- `{major}.{minor}.{patch+1}`：`Issues that we want to release in v{major}.{minor}.{patch+1}.`（state=`open`）

当传入 `--history` 时，每个历史 `vX.Y.Z` tag 还会额外贡献：
- `X.Y.x` 作为开启状态的线里程碑
- `X.Y.Z` 作为关闭状态的版本里程碑（`state=closed`）

### 4. 输出与行为保证

摘要必须包含：
- 版本基线
- 是否启用 `--history`
- 创建与跳过的里程碑数量
- 新创建的里程碑标题
- 已存在的里程碑标题

执行说明：
- Milestone titles are treated as the idempotency key.
- General Backlog 是未分类工作的兜底里程碑。
- 不带 `--history` 时，只为下一次 patch 发布创建版本里程碑。
- 历史 `X.Y.Z` tag 会生成开启状态的 `X.Y.x` 和关闭状态的 `X.Y.Z`。
- 标签较多的仓库可能触发平台 API rate limit。

### 5. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

输出 milestones 初始化摘要后，提示：

```
下一步 - 初始化 Labels（可选）：
  - Claude Code / OpenCode：/init-labels
  - Gemini CLI：/agent-infra:init-labels
  - Codex CLI：$init-labels
```

## 错误处理

- 未找到平台 CLI：提示 "the platform CLI is not installed"
- 认证失败：提示 "the platform CLI is not authenticated"
- 仓库访问失败：提示 "Unable to access the current repository with the platform CLI"
- 版本解析失败：提示 "Unable to determine current version baseline"
- `--history` 模式下未找到任何 `v*` git tags：提示 "No history tags found matching v*; only standard milestones will be created"
- 权限不足：提示 "No permission to manage milestones in this repository"
- API 限流：提示 "platform API rate limit reached, please retry later"
