---
name: test-integration
description: >
  执行项目集成测试流程。
  当用户要求运行集成测试或端到端验证时触发。
---

# 运行集成测试

执行项目的集成测试流程，进行端到端验证。

## 1. 验证前置条件

确认 Node.js >= 18 已安装（用于内置测试运行器）。

```bash
node --version
```

本项目无构建步骤，无需验证构建产物。

## 2. 运行集成测试

本项目的集成测试包含在统一测试套件中（如在临时目录中运行 `ai init` 并验证结果）。

```bash
node --test tests/cli/*.test.js tests/templates/*.test.js tests/core/*.test.js tests/scripts/*.test.js
```

## 3. 输出结果

报告结果：
- 运行/通过/失败的测试数
- 环境问题（如有）
- 失败详情（如有）

## 失败处理

如果测试失败：
- 输出失败详情
- 检查环境问题（端口占用、服务未运行等）
- 不要自动修复 —— 等待用户决定

## 后续步骤

测试通过后，建议提交变更：

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

```
下一步 - 提交代码：
  - Claude Code / OpenCode：/commit
  - Gemini CLI：/agent-infra:commit
  - Codex CLI：$commit
```

## 注意事项

1. **前置条件**：通常需要先成功构建（执行 test 技能）
2. **环境**：集成测试可能需要外部服务（数据库、API 等）
3. **超时**：集成测试通常耗时较长；请耐心等待
4. **清理**：确保测试完成后清理测试环境
