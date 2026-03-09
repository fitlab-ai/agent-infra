---
name: test-integration
description: >
  执行项目集成测试流程。
  当用户要求运行集成测试或端到端验证时触发。
---

# 运行集成测试

执行项目的集成测试流程，进行端到端验证。

<!-- TODO: 将以下命令替换为你的项目实际命令 -->

## 1. 验证构建产物

在运行集成测试前确保项目已构建。

```bash
# TODO: 替换为你的项目构建验证命令
# ls build/              (检查构建输出是否存在)
# npm run build          (Node.js)
# mvn package -DskipTests  (Maven)
```

如果构建产物不存在，提示用户先执行 test 技能。

## 2. 运行集成测试

```bash
# TODO: 替换为你的项目集成测试命令
# npm run test:integration    (Node.js)
# mvn verify                  (Maven)
# pytest tests/integration/   (Python)
# go test -tags=integration ./...  (Go)
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

测试通过后，建议提交变更。

## 注意事项

1. **前置条件**：通常需要先成功构建（执行 test 技能）
2. **环境**：集成测试可能需要外部服务（数据库、API 等）
3. **超时**：集成测试通常耗时较长；请耐心等待
4. **清理**：确保测试完成后清理测试环境
