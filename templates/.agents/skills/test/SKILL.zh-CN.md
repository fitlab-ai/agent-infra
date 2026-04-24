---
name: test
description: "执行项目完整测试流程"
---

# 执行测试

执行项目的完整测试流程，包括编译检查和单元测试。

<!-- TODO: 将以下命令替换为你的项目实际命令 -->

## 1. 编译 / 类型检查

```bash
# TODO: 替换为你的项目编译命令
# npx tsc --noEmit       (TypeScript)
# mvn compile             (Maven)
# go build ./...          (Go)
# make build              (通用)
```

确认无编译错误。

## 2. 运行所有单元测试

```bash
# TODO: 替换为你的项目测试命令
# npm test                (Node.js)
# mvn test                (Maven)
# pytest                  (Python)
# go test ./...           (Go)
```

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
  - Gemini CLI：/{{project}}:commit
  - Codex CLI：$commit
```
