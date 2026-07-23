---
name: test-integration
description: >
  执行项目集成测试流程。
  当需要运行集成测试或端到端验证时使用。
---

# 运行集成测试

执行项目的集成测试流程，进行端到端验证。

## 1. 构建并运行集成测试

项目使用 TypeScript，并将集成测试和端到端测试作为同一套跨模块验证入口：

```bash
npm run test:integration
```

该脚本先执行 `npm run build`，再运行 `tests/integration/**/*.test.ts` 和
`tests/e2e/**/*.test.ts`，并启用 Node.js TypeScript strip-types 支持。

## 2. 输出结果

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

1. **前置条件**：Node.js >= 22.9.0；脚本会自动构建
2. **环境**：集成测试可能需要外部服务（数据库、API 等）
3. **超时**：集成测试通常耗时较长；请耐心等待
4. **清理**：确保测试完成后清理测试环境
