---
name: commit
description: "提交当前变更到 Git"
---

# 提交代码

在不覆盖用户本地工作的前提下创建 Git commit，并在需要时更新关联任务状态。

## 1. 检查本地修改（关键）

在任何编辑前先检查：

```bash
git status --short
git diff
```

必须尊重现有用户改动；如果你的计划与之冲突，先停止并征求确认。

## 2. 更新版权头年份

动态获取当前年份，只更新已经改动过的文件。

> 完整版权检查流程见 `reference/copyright-check.md`。修改任何版权头前，先读取 `reference/copyright-check.md`。

## 3. 生成提交信息

检查状态、diff 和最近历史，然后按 Conventional Commits 生成 message，并补齐正确的协作署名。

> 提交信息规则、示例和多代理署名细节见 `reference/commit-message.md`。写 commit message 前先读取 `reference/commit-message.md`。

## 4. 创建提交

只暂存明确列出的文件，然后执行 `git commit`。

## 5. 按需更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

> 完整的 4 种状态分支、前置条件检查和多 TUI 下一步命令见 `reference/task-status-update.md`。更新任务状态前，先读取 `reference/task-status-update.md`。

> **重要**：向用户展示下一步时，必须完整输出所有 TUI 命令格式，并直接使用 `reference/task-status-update.md` 中对应场景的标准模板。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

追加 Commit 的 Activity Log，并且只能选择一个下一步分支：
- 最终提交 -> `complete-task {task-id}`
- 还有后续工作 -> 更新 task.md 后停止
- 准备审查 -> `review-task {task-id}`
- 准备创建 PR -> `create-pr`

## 6. 同步 Issue 元数据（按需）

当 `{task-id}` 存在且 task.md 包含有效 `issue_number` 时，同步 `in:` label 和需求复选框到关联 Issue；否则跳过。

> 触发条件、`in:` label 计算规则和复选框同步流程见 `reference/issue-metadata-sync.md`。执行前先读取该文件。
>
> 如果本步骤会访问代码托管平台，则先按 `.agents/rules/issue-pr-commands.md` 完成前置检测。

失败处理与「按需更新任务状态」一致：警告但**不**阻塞已完成的 `git commit`。

## 7. 同步 PR 摘要（按需）

当 `{task-id}` 存在且 task.md 包含有效 `pr_number` 时，刷新 PR 上的 `<!-- sync-pr:{task-id}:summary -->` 摘要评论；否则跳过。

> 完整的触发条件、聚合规则、PATCH/POST 流程、Shell 安全约束和错误处理见 `reference/pr-summary-sync.md`（其内联引用 `.agents/rules/pr-sync.md`）。执行此步骤前先读取 `reference/pr-summary-sync.md`。
>
> 如果本步骤会访问代码托管平台，则先按 `.agents/rules/issue-pr-commands.md` 完成前置检测，确保 `.agents/rules/pr-sync.md` 所需的运行时上下文已就绪。

失败处理与「按需更新任务状态」一致：警告但**不**阻塞已完成的 `git commit`。

## 8. 完成校验

如果本次操作关联了 `{task-id}`，运行完成校验，确认任务元数据和同步状态符合规范；如果没有任务上下文，跳过本步骤。

```bash
node .agents/scripts/validate-artifact.js gate commit .agents/workspace/active/{task-id}
```

处理结果：
- 退出码 0（全部通过）-> 继续后续收尾步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

## 注意事项

- 不要提交 `.env`、凭据、密钥等敏感文件
- 协作署名中当前代理必须排在最前面
- 不要使用 `git add -A` 或 `git add .`

## 错误处理

- 如果任务状态更新失败，警告用户，但不要因此阻止提交
