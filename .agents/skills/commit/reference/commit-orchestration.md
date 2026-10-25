# Commit Core 边界

commit、push、结果映射和任务收尾使用同一个 `commit-operation.execute`。入口解析 task scope、显式 agent 与调用参数；执行模式固定为 `direct`，交付模式由调用方明确指定为 `local` 或 `push`。

## 入口契约

- task-bound direct 可读取任务事实；taskless direct 只在 `TASK_CONTEXT_NOT_FOUND` 时允许，并跳过 task facts、review、checkpoint 和 task.md 收尾。
- 本地 checkpoint 由 `code-task` 通过共享 core 以 `delivery=local` 执行；独立 `commit` 使用 `delivery=push`。两者共享同一校验与提交顺序。

## 共享执行顺序

1. 按调用方语义串行执行。
2. 验证 repository、当前 branch、明确 paths、敏感路径、staged scope、expected HEAD/tree、remote 和 full heads ref。
3. 完成 direct 模式授权校验。
4. 最多创建一个本地 commit；无修改时只允许 push-only，不创建空 commit。
5. `main` / `master` 自动 push 返回 `COMMIT_AUTOPUSH_PROTECTED_BRANCH` warning；普通 push 失败返回 `COMMIT_PUSH_FAILED` warning，并保留本地事实。
6. 返回唯一主结果：`committed`、`no_op`、`committed_with_warnings`、`failed` 或 `blocked`。

## 重试边界

重跑重新读取当前 HEAD、worktree、branch 和 remote 事实。已有本地 commit 时只补 push，不创建第二个 commit；taskless 重跑不创建任何任务记录。
