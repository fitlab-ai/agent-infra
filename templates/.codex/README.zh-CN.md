# Codex 项目级 Prompts（ai-collaboration-installer）

本目录提供 ai-collaboration-installer 仓库的 Codex prompts（用于生成/管理 slash 命令的文档版本）。
由于 Codex CLI 的自定义 prompts 只会从用户目录读取（默认 `~/.codex/prompts/`），
这里的内容需要手动安装到本地目录后才会生效。

## 命名空间

所有命令文件以 `collaborator-` 为前缀，避免与其他项目的同名命令冲突。
在 Codex CLI 中使用 `/prompts:collaborator-<name>` 调用（例如：`/prompts:collaborator-test`）。

> **为什么需要前缀？** Codex 的自定义 prompts 是全局的（`~/.codex/prompts/`），
> 当你同时使用多个项目时，相同名称的命令会互相覆盖。
> 添加项目前缀后，各项目的命令可以共存。

## 安装到本地

运行安装脚本，将本目录的 prompts 复制到 `~/.codex/prompts/`：

```bash
bash .codex/scripts/install-prompts.sh
```

安装完成后，使用 `/prompts:collaborator-<name>` 调用（例如：`/prompts:collaborator-analyze-issue`）。

## Prompt 文件格式规范

```yaml
---
description: 命令的功能描述
usage: /prompts:collaborator-command-name <参数>
argument-hint: <参数>
---
```

### 字段说明

- **description**（必需）：描述 prompt 的功能
- **usage**（推荐）：完整的使用示例，包含命令名和参数
- **argument-hint**（可选）：仅参数部分的描述（Codex 官方格式）
  - 使用 `<param>` 表示必需参数
  - 使用 `[param]` 表示可选参数

## 参数传递

| 占位符                       | 含义             | 适用场景                     |
|---------------------------|----------------|--------------------------|
| `$1`, `$2`, `$3` ... `$9` | 位置参数（按空格分隔）    | 结构化参数，如 task-id、issue 编号 |
| `$ARGUMENTS`              | 所有参数拼接为一个完整字符串 | 自由文本输入，如任务描述             |

### `$1` vs `$ARGUMENTS` 的区别

当用户输入 `/prompts:collaborator-create-task 给 postman 添加优雅停机功能` 时：

| 占位符          | 展开结果                            |
|--------------|---------------------------------|
| `$1`         | `给`（仅第一个空格分隔的词）                 |
| `$ARGUMENTS` | `给 postman 添加优雅停机功能`（完整字符串） |

因此：
- **结构化参数**（task-id、issue 编号等）使用 `$1`、`$2`
- **自由文本**（任务描述等）必须使用 `$ARGUMENTS`

## 可用命令列表

**项目设置**：
- `collaborator-update-project` - 更新项目 AI 协作配置到最新模板

**任务管理**：
- `collaborator-create-task` - 根据自然语言描述创建任务
- `collaborator-analyze-issue` - 分析 GitHub Issue 并创建需求分析文档
- `collaborator-plan-task` - 设计技术方案并输出实施计划
- `collaborator-implement-task` - 根据技术方案实施任务
- `collaborator-review-task` - 审查任务实现并输出代码审查报告
- `collaborator-refine-task` - 处理代码审查反馈并修复问题
- `collaborator-complete-task` - 标记任务完成并归档到 completed 目录
- `collaborator-check-task` - 查看任务的当前状态和进度
- `collaborator-block-task` - 标记任务阻塞并记录阻塞原因

**Git 操作**：
- `collaborator-commit` - 提交当前变更到 Git（含版权头检查）
- `collaborator-create-pr` - 创建 Pull Request
- `collaborator-sync-pr` - 将任务处理进度同步到 PR 评论
- `collaborator-sync-issue` - 将任务处理进度同步到 Issue 评论
- `collaborator-refine-title` - 重构 Issue/PR 标题为 Conventional Commits 格式

**测试**：
- `collaborator-test` - 执行项目测试流程
- `collaborator-test-integration` - 执行集成测试

**发布**：
- `collaborator-release` - 执行版本发布流程
- `collaborator-create-release-note` - 生成发布说明

**依赖和安全**：
- `collaborator-upgrade-dependency` - 升级项目依赖
- `collaborator-analyze-dependabot` - 分析 Dependabot 依赖漏洞告警
- `collaborator-close-dependabot` - 关闭 Dependabot 依赖漏洞告警
- `collaborator-analyze-codescan` - 分析 Code Scanning 告警
- `collaborator-close-codescan` - 关闭 Code Scanning 告警

## 常见问题

### Q: 为什么命令都有 `collaborator-` 前缀？

A: Codex 的自定义 prompts 是全局的（`~/.codex/prompts/`），不同项目的同名命令会互相覆盖。
添加项目前缀后可以区分不同项目的命令，多个项目的命令可以同时共存。

### Q: 如何自定义技术栈相关命令？

A: 带有 `<!-- TODO -->` 标记的命令（test、test-integration、release、upgrade-dependency）
包含占位示例。请将 TODO 部分替换为你项目的实际命令。
