---
name: restore-task
description: >
  从平台 Issue 评论还原本地任务文件。
  当本地任务文件缺失、需要从平台 Issue 评论还原时使用。
---

# 还原任务

从带有 sync 标记的平台 Issue 评论中恢复本地任务工作区文件。

## 行为边界 / 关键规则

- 只从匹配 `.agents/rules/issue-sync.md` 标记注册表的评论恢复文件
- 默认恢复到 `.agents/workspace/active/{task-id}/`
- 如果目标目录已存在，立即停止并提示用户先处理目录冲突
- 执行本技能后，你**必须**立即更新恢复出的 `task.md`

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：写入 started 标记

确认前置条件后、本步骤第一个产出动作之前，向 task.md `## 活动日志` 追加一条 started 标记（与本步骤 done 条目同基名 + ` [started]` 后缀，note 用 `started`）：

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Restore Task [started]** by {agent} — started
```

`ai task log` 会把它与完成时写入的 done 条目配对成一行（进行中 → 已完成）。约定见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

## 执行步骤
### 1. 验证输入与环境

检查：
- 必填参数 `{issue-number}`
- 可选参数 `{task-id}`
- 执行前先读取 `.agents/rules/issue-pr-commands.md`，并按其中的认证命令验证当前平台访问能力

如果用户传入了 `{task-id}`，校验其格式为 `TASK-{yyyyMMdd-HHmmss}`。

### 2. 获取 Issue 评论

按 `.agents/rules/issue-pr-commands.md` 中的 “Issue 评论读取” 命令读取 Issue 的全部评论，保留原始顺序和评论 ID。

### 3. 确定 task-id 与待恢复文件

按 `.agents/rules/issue-sync.md` 中定义的 task、artifact 和分片 artifact 标记筛选评论。

处理规则：
- 用户提供了 `{task-id}` 时，仅匹配该任务
- 未提供时，优先从 task 评论标记推断
- 若找不到唯一 task-id，立即停止并告知用户
- 忽略 `summary` 标记评论；它是 complete-task 的聚合产物，不对应本地任务文件
- 将 `{file-stem}` 映射回文件名：
  - `task` -> `task.md`
  - `analysis` / `analysis-r{N}` -> 对应 `.md`
  - `review-analysis` / `review-analysis-r{N}` -> 对应 `.md`
  - `plan` / `plan-r{N}` -> 对应 `.md`
  - `review-plan` / `review-plan-r{N}` -> 对应 `.md`
  - `code` / `code-r{N}` -> 对应 `.md`
  - `review-code` / `review-code-r{N}` -> 对应 `.md`

### 4. 处理分片并检查本地目录

执行本步骤前先读取 `.agents/rules/issue-sync.md`。

对每个文件执行：
- 收集单条评论或分片评论
- 对 `task.md` 评论按 issue-sync.md 中的 `<details>` frontmatter 格式反向拆解，提取 frontmatter 后再与正文拼合
- 如分片标记中存在 part 和 total 序号，按 part 升序排序并校验分片完整
- 从评论正文中提取文件内容，去掉隐藏标记、标题和页脚
- 拼接得到最终文件内容

在写文件前检查：
- `.agents/workspace/active/{task-id}/` 不存在

如果目录已存在，立即停止并提示用户先手动处理。

### 5. 写回本地文件

创建 `.agents/workspace/active/{task-id}/`，按以下顺序写回：

1. `task.md`
2. 其余产物文件（按文件名排序）

仅写回从 Issue 评论中实际恢复出的文件，不补造缺失文件。

### 6. 更新恢复后的 task.md

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新恢复出的 `task.md`：
- `status`：`active`
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}
- `agent_infra_version`：按 `.agents/rules/version-stamp.md` 取值

追加 Activity Log，说明任务已从平台 Issue 还原。

**重新分配短号**（已把任务目录写回 `active/`，需要在锁内重新 alloc；新短号可能与归档前不同）：

```bash
node .agents/scripts/task-short-id.js alloc "$task_id"
```

### 7. 告知用户

报告已恢复的 task id、恢复文件数量和 active task 目录。



## 完成检查清单

- [ ] 已从平台获取 Issue 评论
- [ ] 已恢复本地任务文件
- [ ] 已更新恢复出的任务元数据
- [ ] 已报告恢复目录

### 8. 停止

完成检查清单后立即停止。不要自动提交。
