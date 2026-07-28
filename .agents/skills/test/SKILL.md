---
name: test
description: >
  执行项目完整测试流程（编译检查 + 单元测试）。
  当需要运行测试或验证代码质量时使用。
---

# 执行测试

执行项目的完整测试流程，包括编译检查和单元测试。

## 1. 编译 / 类型检查

```bash
npm run typecheck
```

项目测试脚本会先运行 `npm run build`，因此单独执行类型检查后无需在本步骤重复构建。

## 2. 运行单元测试（按层级选择）

三层测试是反馈速度优化；本项目按测试的可观察范围与运行成本选择对应层级。新增测试文件默认归入 **full**，确认足够快且足够核心后，再上调到 core 或 smoke。

### smoke（目标 <5s）

```bash
npm run test:smoke
```

适用场景：
- code-task 内循环
- 保存即跑 / 频繁反馈
- 仅断言项目结构、配置、模板契约

### core（目标 <15s）

```bash
npm run test:core
```

适用场景：
- pre-commit hook（自动调用）
- 写 code.md / code-r{N}.md 报告前的最终验证
- 推送 PR 前的本地把关

### full（目标 <60s）

```bash
npm test
```

适用场景：
- release / tag 前
- CI（unit-tests.yml）
- main 合并前的最终把关

full 层运行全部项目测试。`npm test` 使用通配匹配项目测试文件，**新增的测试文件会自动归入 full**，这是安全网。

## 3. 输出结果

报告测试结果摘要：
- 运行的总测试数
- 通过数量
- 失败数量（包含每个失败的详情）
- 测试覆盖率（如已配置）

## 失败处理

如果测试失败：
- 输出失败详情和建议的修复方向
- 不要自动修复代码 —— 等待用户决定

## 后续步骤

测试通过后，建议提交变更：

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，仅为已选场景调用统一 helper，并将 stdout 填入 `{next-step-commands}`。

使用 `agent-infra-internal agent-client next-steps --skill commit` 生成本场景的 `{next-step-commands}`。

```
下一步 - 提交代码：
{next-step-commands}
```
