# OpenCode 命令

本目录包含 [OpenCode](https://opencode.ai) AI 编码助手的命令文件。

## 目录结构

```
.opencode/
  README.md                          # 英文说明
  README.zh-CN.md                    # 本文件
  COMMAND_STYLE_GUIDE.md             # 命令编写指南
  commands/
    {command}.md                     # 英文命令文件
    {command}.zh-CN.md               # 中文命令文件
```

## 命令格式

每个命令文件使用带 YAML 前置元数据的 Markdown 格式：

```markdown
---
description: 命令功能的简要描述
agent: general
subtask: false
---

AI 代理的分步指令。
使用 `!` 前缀标记需要直接执行的 shell 命令。
使用 markdown 代码块展示不需要自动执行的示例。
```

## 可用命令

### 项目设置
- `update-agent-infra` - 更新项目配置

### 开发
- `commit` - 提交当前变更到 Git
- `test` - 运行单元测试（TODO: 需适配技术栈）
- `test-integration` - 运行集成测试（TODO: 需适配技术栈）

### 任务管理
- `create-task` - 从自然语言描述创建任务
- `import-issue` - 导入 GitHub Issue 为任务
- `analyze-task` - 分析任务需求
- `plan-task` - 为任务设计技术方案
- `implement-task` - 根据方案实施任务
- `review-task` - 审查任务实现
- `refine-task` - 处理审查反馈
- `complete-task` - 标记任务完成并归档
- `check-task` - 查看任务状态
- `block-task` - 标记任务为阻塞

### PR 和同步
- `create-pr` - 创建 Pull Request
- `sync-pr` - 同步任务进度到 PR 评论

### 安全
- `import-dependabot` - 导入 Dependabot 告警
- `close-dependabot` - 关闭 Dependabot 告警
- `import-codescan` - 导入 Code Scanning 告警
- `close-codescan` - 关闭 Code Scanning 告警

### 发布和维护
- `release` - 创建发布版本（TODO: 需适配技术栈）
- `create-release-note` - 生成发布说明
- `refine-title` - 优化 Issue/PR 标题
- `upgrade-dependency` - 升级依赖（TODO: 需适配技术栈）

## 约定

- 命令是**工具无关**和**技术栈无关**的
- 带 `TODO` 标记的命令需要根据项目具体技术栈进行定制
- 所有时间戳动态生成（禁止硬编码）
- GitHub API 路径使用 `{owner}/{repo}` 占位符
