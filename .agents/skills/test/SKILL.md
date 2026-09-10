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

## 2. 运行测试（按层级选择）

测试层级是反馈速度优化；本项目按测试的可观察范围与运行成本选择对应层级。新增测试文件默认归入 **full**，确认足够快且足够核心后，再上调到 core 或 smoke。

### fast smoke（参考目标 <10s）

```bash
npm run test:smoke:fast
```

与 smoke 运行相同的 unit 测试范围，但跳过构建。仅用于代码修改后的内循环；完成一个实施步骤后仍须运行 smoke，以验证最新构建产物。

runner 默认使用 `availableParallelism() * 2` 个测试进程；需要固定并发时可设置 `AGENT_INFRA_TEST_CONCURRENCY`，例如 `AGENT_INFRA_TEST_CONCURRENCY=4 npm run test:smoke:fast`。

### platform-smoke（跨平台边界）

```bash
npm run test:platform-smoke:fast
```

运行从 unit 迁出的真实 CLI、git、shell 和子进程测试。该层在 Windows/macOS 上保留原有跨平台执行边界；完整 integration 测试仍由 `test:core`、`test:integration` 或 CI integration job 执行。

CI 的 Ubuntu integration job 和最低 Node 全量基线将 `AGENT_INFRA_TEST_CONCURRENCY` 固定为 `2`，Windows/macOS 的 platform-smoke 固定为 `1`，以避免宿主机进程密集测试在共享 runner 上出现超时；本地运行仍使用默认并发策略。

### smoke（参考目标 <10s）

```bash
npm run test:smoke
```

适用场景：
- code-task 的实施步骤完成后
- 仅断言项目结构、配置、模板契约

### core（参考目标 <95s）

```bash
npm run test:core
```

适用场景：
- pre-commit hook（自动调用）
- 写 code.md / code-r{N}.md 报告前的最终验证
- 推送 PR 前的本地把关

### full（参考目标 <100s）

```bash
npm test
```

适用场景：
- release / tag 前
- CI（unit-tests.yml）
- main 合并前的最终把关

full 层运行全部项目测试。`npm test` 使用通配匹配项目测试文件，**新增的测试文件会自动归入 full**，这是安全网。参考目标是反馈预算，不是 CI gate。

`npm run test:coverage` 只在 main push 的独立 CI job 中运行；覆盖率用于定位薄弱区域，不设置百分比门槛，也不阻塞合并。

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
