---
name: init-labels
description: >
  初始化仓库的 labels 体系。
  当初始化仓库、需要创建标准 label 体系时使用。
---

# 初始化 labels

一次性初始化仓库的标准 labels 体系。

## 执行流程

### 1. 验证前置条件

确认以下条件成立：
- 执行前先读取 `.agents/rules/label-milestone-setup.md`
- 仓库配置和请求的映射已准备完成

如果任一条件失败，停止并输出对应错误。

### 2. 运行初始化脚本

执行以下命令，完成整套 label 初始化流程：

```bash
bash .agents/skills/init-labels/scripts/init-labels.sh
```

脚本与 `.agents/rules/label-milestone-setup.md` 共同负责：
- 读取配置的 `labels.in` 映射并保留无关 label
- 选择 provider 叶子，或返回明确的 no-op/degraded 结果
- 创建或更新标准 label 集合并输出最终摘要
- 输出最终执行摘要

### 3. 标准分类体系

脚本管理以下通用 label 族：
- `type:` labels，例如 `type: bug`、`type: enhancement`、`type: feature`、`type: documentation`、`type: dependency-upgrade`、`type: task`
- `status:` labels，例如 `status: waiting-for-triage`、`status: in-progress`、`status: waiting-for-internal-feedback`
- 明确覆盖的 平台默认同名 labels：`good first issue` 和 `help wanted`
- 额外通用 labels，例如 `dependencies`

#### 适用范围

| Label 前缀 | Issue | PR | 说明 |
|---|---|---|---|
| `type:` | — | Yes | Issue 使用 平台原生 Type 字段；PR 无原生类型字段，需 `type:` label 驱动 changelog |
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
2. 执行 `bash .agents/skills/init-labels/scripts/init-labels.sh`，为每个映射 key 创建或更新 `in: {key}` label。
3. 询问用户确认后，再使用 `--cleanup-stale-in` 重新执行脚本，清理不在最终映射中的旧 `in:` label。

### 5. 输出与行为保证

摘要必须包含：
- 创建或更新的通用 labels 数量
- 写入的 `labels.in` 映射结果
- 按映射 key 计算的 `in:` labels 数量
- 名称完全匹配的平台预置 labels 已被覆盖的说明
- 仍然存在的未匹配平台预置 labels

执行说明：
- 整个操作具备幂等性，因为 provider 叶子会按覆盖或更新方式处理已有 label。
- `in:` labels 由 AI 引导步骤和 `.airc.json` 映射统一管理。

### 6. 告知用户

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

输出 labels 初始化摘要后，提示：

使用 `agent-infra-internal agent-client next-steps --skill init-milestones` 生成本场景的 `{next-step-commands}`。

```
下一步 - 初始化 Milestones（可选）：
{next-step-commands}
```

## 错误处理

- provider 能力不可用：如实报告脚本的 `degraded` 或 `no-op` 结果，不得声称远端已变更。
- provider 认证或仓库访问失败：如实报告脚本返回的结构化错误。
- 权限不足：提示 "No permission to manage labels in this repository"
- API 限流：提示 "platform API rate limit reached, please retry later"
