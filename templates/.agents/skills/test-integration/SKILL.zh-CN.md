---
name: test-integration
description: >
  执行项目集成测试流程。
  当需要运行项目集成测试流程时使用。
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

如果构建产物不存在，先在当前任务范围内执行已配置的构建步骤；检查失败输出并修复可诊断的本地问题。只有构建需要缺失的环境或授权时才保留阻塞状态。

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
- 在任务范围内且可诊断时，先检查证据并修复本次引入的问题，再运行相同测试验证；涉及范围外设计、用户数据冲突或必要授权时记录阻塞并继续独立工作。

## 后续步骤

测试通过后，建议提交变更：

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

使用 `agent-infra-internal agent-client next-steps --skill commit` 生成本场景的 `{next-step-commands}`。

```
下一步 - 提交代码：
{next-step-commands}
```

## 注意事项

1. **前置条件**：通常需要先成功构建（执行 test 技能）
2. **环境**：集成测试可能需要外部服务（数据库、API 等）
3. **超时**：集成测试通常耗时较长；请耐心等待
4. **清理**：确保测试完成后清理测试环境


遇到任务范围内且可诊断的失败，先读取错误证据、定位根因、修复并按同一验证器重试；不要仅因一次普通失败就停止或提问。若涉及用户数据/模板冲突、超出批准范围的设计选择、必要人工验证/授权或无法安全恢复，则保留阻塞事实并继续独立工作。
