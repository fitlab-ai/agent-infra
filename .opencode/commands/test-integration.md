---
name: "test-integration"
description: "执行集成测试流程"
usage: "/test-integration"
---

# Integration Test Command

## 功能说明

执行项目的集成测试。

## 步骤 1：验证前置条件

确认 Node.js >= 18 已安装（用于内置测试运行器）。

```bash
node --version
```

本项目无构建步骤，无需验证构建产物。

## 步骤 2：运行集成测试

本项目的集成测试包含在统一测试套件中（如在临时目录中运行 `aci init` 并验证结果）。

```bash
node --test tests/*.test.js
```

## 步骤 3：输出结果

报告测试结果：
- 测试数量 / 通过数 / 失败数
- 环境问题（如果有）
- 失败详情（如果有）

## 失败处理

如果测试失败：
- 输出失败详情
- 检查环境问题（端口占用、服务未启动等）
- **不要**自动修复 - 等待用户决定

## 下一步

测试通过后，使用以下命令提交代码：
- Claude Code / OpenCode: `/commit`
- Gemini CLI: `/ai-collaboration-installer:commit`
- Codex CLI: `/prompts:ai-collaboration-installer-commit`

## 注意事项

1. **前置条件**：通常需要先完成构建（运行 `/test`）
2. **环境依赖**：集成测试可能依赖外部服务（数据库、API 等）
3. **超时设置**：集成测试通常耗时较长，请耐心等待
4. **环境清理**：确保测试完成后清理测试环境
