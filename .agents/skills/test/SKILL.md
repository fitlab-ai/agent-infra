---
name: test
description: >
  执行项目完整测试流程（编译检查 + 单元测试）。
  当用户要求运行测试或验证代码质量时触发。
---

# 执行测试

执行项目的完整测试流程，包括编译检查和单元测试。

## 1. 编译 / 类型检查

本项目由 Node.js CLI 和模板文件组成，无需编译。跳过此步骤。

## 2. 运行单元测试（按层级选择）

本项目把测试分为三层，按场景选择运行命令；新增测试文件默认归入 **full**，确认足够快且足够核心后，再上调到 core 或 smoke。

### smoke（目标 <5s）

```bash
npm run test:smoke
```

适用场景：
- implement-task / refine-task 内循环
- 保存即跑 / 频繁反馈
- 仅断言项目结构、配置、模板契约

### core（目标 <15s）

```bash
npm run test:core
```

适用场景：
- pre-commit hook（自动调用）
- 写 implementation.md / refinement.md 报告前的最终验证
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

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

```
下一步 - 提交代码：
  - Claude Code / OpenCode：/commit
  - Gemini CLI：/agent-infra:commit
  - Codex CLI：$commit
```
