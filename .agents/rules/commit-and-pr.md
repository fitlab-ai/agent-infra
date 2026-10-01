# 通用规则 - 提交与 PR

## 提交信息格式

- 使用 Conventional Commits：`<type>(<scope>): <subject>`
- `type` 仅限：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`
- `scope`：模块名（可省略）
- `subject` 使用英文祈使语气，保持简洁

## 提交执行边界

- 不直接执行 `git add` 或 `git commit`；所有自动提交都必须通过 `agent-infra-internal git-workflow commit` 共享 core，并遵守对应技能提供的 paths、HEAD/tree 和交付模式约束。
- 提交由当前工作流定义。`code-task` 完成实现必须在测试和实现报告 preflight 通过后，通过共享 core 创建一个本地 checkpoint；该要求适用于直接调用和 `run-task` 编排，不需要额外的提交授权或用户确认。
- `code-task` 的本地 checkpoint 不推送远端。其他技能只有在其流程明确要求时才可调用共享 core；独立 `commit` 技能仍须由用户显式调用，并遵循其 push delivery 流程。
- 工作流没有要求提交时，不要自行创建提交；需要用户执行独立提交时，再提示对应 TUI 命令。

## PR 提交规则

创建 PR 前必须确保：
- 所有测试通过
- 代码检查通过
- 构建成功
- 公共 API 已补充文档（如适用）
- 版权头年份已更新（如适用）

## 版权年份更新

- 先运行 `date +%Y` 获取当前年份，不要硬编码
- 更新格式示例：
  - `2024-2025` -> `2024-2026`
  - `2024` -> `2024-2026`
