---
name: init-labels
description: "初始化仓库的 GitHub Labels 体系"
---

# 初始化 GitHub Labels

一次性初始化仓库的标准 GitHub Labels 体系。

## 执行流程

### 1. 验证前置条件

确认以下条件成立：
- 已安装 `gh`
- `gh auth token` 执行成功
- `gh repo view --json nameWithOwner` 可以访问当前仓库

如果任一条件失败，停止并输出对应错误。

### 2. 运行初始化脚本

执行以下命令，完成整套 label 初始化流程：

```bash
bash .agents/skills/init-labels/scripts/init-labels.sh
```

脚本负责：
- 在修改前保存当前 label 快照
- 使用 `gh label create --force` 创建或更新标准 label 集合
- 自动探测顶层目录，并为有效目录创建对应的 `in:` label
- 在没有可用目录时回退到 `in: core`
- 提示仍然存在的 GitHub 默认 labels，例如 `question` 和 `wontfix`
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

### 4. 范围探测规则

目录派生 label 遵循以下规则：
- 只探测项目顶层目录
- 排除隐藏目录和常见构建/缓存目录
- 仅当没有有效目录时才创建 `in: core`
- 本技能不创建任何 `theme:` labels

### 5. 输出与行为保证

摘要必须包含：
- 创建或更新的通用 labels 数量
- 创建或更新的 `in:` labels 数量
- 名称完全匹配的 GitHub 默认 labels 已被覆盖的说明
- 仍然存在的未匹配 GitHub 默认 labels

执行说明：
- 整个操作具备幂等性，因为每个 label 都使用 `gh label create --force`。
- 如果自动探测出的 `in:` labels 需要细化，请在初始化后手动调整。

## 错误处理

- 未找到 `gh`：提示 "GitHub CLI (`gh`) is not installed"
- 认证失败：提示 "GitHub CLI is not authenticated"
- 仓库访问失败：提示 "Unable to access the current repository with gh"
- 权限不足：提示 "No permission to manage labels in this repository"
- API 限流：提示 "GitHub API rate limit reached, please retry later"
