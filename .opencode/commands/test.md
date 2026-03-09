---
name: "test"
description: "执行完整的测试流程（编译 + 单元测试）"
usage: "/test"
---

# Test Command

## 功能说明

执行项目的完整测试流程。

## 步骤 1：编译 / 类型检查

本项目由 Shell 脚本和模板文件组成，无需编译。跳过此步骤。

## 步骤 2：运行全部单元测试

```bash
node --test tests/*.test.js
```

## 步骤 3：输出结果

报告测试结果摘要：
- 总测试数
- 通过数
- 失败数（含每个失败的详情）
- 测试覆盖率（如果已配置）

## 失败处理

如果测试失败：
- 输出失败详情和建议修复方向
- **不要**自动修复代码 - 等待用户决定

## 下一步

测试通过后，使用以下命令提交代码：
- Claude Code / OpenCode: `/commit`
- Gemini CLI: `/ai-collaboration-installer:commit`
- Codex CLI: `/prompts:ai-collaboration-installer-commit`
