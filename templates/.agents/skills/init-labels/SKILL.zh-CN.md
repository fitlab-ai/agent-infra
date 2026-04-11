---
name: init-labels
description: "初始化仓库的 GitHub Labels 体系"
---

# 初始化 GitHub Labels

一次性初始化仓库的标准 GitHub Labels 体系。

## 执行流程

### 1. 验证前置条件

确认以下条件成立：
- 执行前先读取 `.agents/rules/label-milestone-setup.md`
- 按其中的认证命令验证平台访问能力

如果任一条件失败，停止并输出对应错误。

### 2. 运行初始化脚本

执行以下命令，完成整套 label 初始化流程：

```bash
bash .agents/skills/init-labels/scripts/init-labels.sh
```

脚本与 `.agents/rules/label-milestone-setup.md` 共同负责：
- 在修改前保存当前 label 快照
- 使用平台对应的 label 创建或更新命令维护标准 label 集合
- 提示仍然存在的平台预置 labels，例如 `question` 和 `wontfix`
- 输出最终执行摘要

### 3. 标准分类体系

脚本管理以下通用 label 族：
- `type:` labels，例如 `type: bug`、`type: enhancement`、`type: feature`、`type: documentation`、`type: dependency-upgrade`、`type: task`
- `status:` labels，例如 `status: waiting-for-triage`、`status: in-progress`、`status: waiting-for-internal-feedback`
- 明确覆盖的 GitHub 默认同名 labels：`good first issue` 和 `help wanted`
- 额外通用 labels，例如 `dependencies`

#### 适用范围

| Label 前缀 | Issue | PR | 说明 |
|---|---|---|---|
| `type:` | — | Yes | Issue 使用 GitHub 原生 Type 字段；PR 无原生类型字段，需 `type:` label 驱动 changelog |
| `status:` | Yes | — | PR 有自身状态流转（Open/Draft/Merged/Closed）；Issue 使用 `status:` label 标记项目管理状态 |
| `in:` | Yes | Yes | Issue 和 PR 均需按模块筛选 |

### 4. 配置 `in:` label 映射

检查 `.agents/.airc.json` 中是否已有 `labels.in` 字段。

#### 4.1 已有映射

展示当前映射，询问用户是否需要更新。
- 不需要：跳到步骤 4.3
- 需要：按步骤 4.2 处理

#### 4.2 无映射或用户要求更新

1. 扫描项目顶层目录，排除隐藏目录和常见构建目录。
2. 分析目录内容，给出有意义的模块分组建议。
3. 向用户展示建议的 `in:` label 映射，并根据自然语言反馈迭代调整。
4. 如果用户拒绝配置，则为每个顶层目录生成 1:1 默认映射（`{dir}/`）。

#### 4.3 写入配置并创建 label

1. 将最终映射写入 `.agents/.airc.json` 的 `labels.in` 字段。
2. 为每个映射 key 按 `.agents/rules/label-milestone-setup.md` 的 label 创建命令创建 `in: {key}` label。
3. 询问用户确认后，清理不在最终映射中的旧 `in:` label。

### 5. 输出与行为保证

摘要必须包含：
- 创建或更新的通用 labels 数量
- 写入的 `labels.in` 映射结果
- 按映射 key 计算的 `in:` labels 数量
- 名称完全匹配的平台预置 labels 已被覆盖的说明
- 仍然存在的未匹配平台预置 labels

执行说明：
- 整个操作具备幂等性，因为规则文件中的 label 创建命令按覆盖或更新方式执行。
- `in:` labels 由 AI 引导步骤和 `.airc.json` 映射统一管理。

### 6. 告知用户

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。

输出 labels 初始化摘要后，提示：

```
下一步 - 初始化 Milestones（可选）：
  - Claude Code / OpenCode：/init-milestones
  - Gemini CLI：/agent-infra:init-milestones
  - Codex CLI：$init-milestones
```

## 错误处理

- 未找到 `gh`：提示 "GitHub CLI (`gh`) is not installed"
- 认证失败：提示 "GitHub CLI is not authenticated"
- 仓库访问失败：提示 "Unable to access the current repository with gh"
- 权限不足：提示 "No permission to manage labels in this repository"
- API 限流：提示 "GitHub API rate limit reached, please retry later"
