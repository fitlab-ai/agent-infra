# 通用规则 - 提交与 PR

## 提交信息格式

- 使用 Conventional Commits：`<type>(<scope>): <subject>`
- `type` 仅限：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`
- `scope`：模块名（可省略）
- `subject` 使用英文祈使语气，保持简洁

## 禁止自动提交

- 绝对不要自动执行 `git commit` 或 `git add`
- 仅在用户明确发起提交命令时才进入提交流程
- 唯一例外：用户显式启动的 active `run-task` 可签发一次性 commit authorization；它等价于本轮提交授权，但不得放宽暂存、敏感文件、版权、测试、审查快照、HEAD/tree 或 push 门禁。
- 完成代码修改后，提醒用户使用对应 TUI 的提交命令

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
