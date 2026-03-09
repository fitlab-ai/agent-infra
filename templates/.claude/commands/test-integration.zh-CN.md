---
name: "test-integration"
description: "执行集成测试流程"
usage: "/test-integration"
---

# Integration Test Command

## 功能说明

执行项目的集成测试。

<!-- TODO: 替换为你的项目实际命令 -->

## 步骤 1：验证构建产物

确保项目已完成构建，再运行集成测试。

```bash
# TODO: 替换为你的项目构建验证
# ls build/              (检查构建输出是否存在)
# npm run build          (Node.js)
# mvn package -DskipTests  (Maven)
```

如果构建产物不存在，提示用户先运行 `/test` 命令。

## 步骤 2：运行集成测试

```bash
# TODO: 替换为你的项目集成测试命令
# npm run test:integration    (Node.js)
# mvn verify                  (Maven)
# pytest tests/integration/   (Python)
# go test -tags=integration ./...  (Go)
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
- Gemini CLI: `/{project}:commit`
- Codex CLI: `/prompts:{project}-commit`

## 注意事项

1. **前置条件**：通常需要先完成构建（运行 `/test`）
2. **环境依赖**：集成测试可能依赖外部服务（数据库、API 等）
3. **超时设置**：集成测试通常耗时较长，请耐心等待
4. **环境清理**：确保测试完成后清理测试环境
