# Claude Code - 详细规则

## 规则总览

| 规则 | 级别 | 描述 |
|------|------|------|
| 提交信息格式 | 关键 | Conventional Commits 英文格式 |
| 禁止自动提交 | 关键 | 不自动执行 git commit/add |
| 版权年份更新 | 关键 | 通过 `date +%Y` 动态获取年份 |
| 任务状态管理 | 关键 | 每个命令执行后更新 task.md |
| PR 规范 | 重要 | 添加生成标记 |
| 任务语义识别 | 重要 | 自动识别用户意图 |

## 规则 1: 提交信息格式

格式: `<type>(<scope>): <英文描述>`

类型: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

必须附加 Co-Authored-By 署名（使用你的模型名称）。

使用 HEREDOC 格式处理多行提交信息。

## 规则 2: 禁止自动提交

- 绝对不要自动执行 `git commit` 或 `git add`
- 仅当用户明确使用 `/commit` 命令时才提交
- 完成代码修改后，提醒用户使用 `/commit`

## 规则 3: PR 提交规则

创建 PR 前必须确保：
- 所有测试通过
- 代码检查通过
- 构建成功
- 版权头年份已更新
- 使用 PR 模板格式

## 规则 4: 版权年份更新

- 动态获取年份: `date +%Y`（不要硬编码）
- 更新格式: `Copyright (C) 2024-2025` -> `Copyright (C) 2024-2026`
- 使用 Edit 工具，只更新已修改的文件

## 规则 5: 任务语义识别

自动识别用户意图：
- "分析 issue XXX" -> `/import-issue`
- "分析任务 TASK-..." -> `/analyze-task`
- "设计方案" -> `/plan-task`
- "实施/实现" -> `/implement-task`
- "审查" -> `/review-task`

## 规则 6: 任务状态管理

关键: 每个命令执行后必须立即更新任务状态。

需要更新的命令：
- `/import-issue`: 更新 current_step, updated_at, assigned_to
- `/analyze-task`: 更新 current_step, updated_at, assigned_to
- `/plan-task`: 更新 current_step, updated_at
- `/implement-task`: 更新 current_step, updated_at
- `/review-task`: 更新 current_step, updated_at
- `/complete-task`: 更新 status, completed_at, updated_at
- `/block-task`: 更新 status, blocked_at, blocked_reason
