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

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

使用 `agent-infra-internal agent-client next-steps --skill commit` 生成本场景的 `{next-step-commands}`。

```
下一步 - 提交代码：
{next-step-commands}
```

## 注意事项

1. **前置条件**：Node.js >= 22.9.0；脚本会自动构建
2. **环境**：集成测试可能需要外部服务（数据库、API 等）
3. **超时**：集成测试通常耗时较长；请耐心等待
4. **清理**：确保测试完成后清理测试环境
