# Commit Core 边界

commit、push、结果映射和任务收尾使用同一个 `commit-operation.execute`。入口只负责解析 task scope、显式 agent 和字面 `--orchestrated`，不得从状态文件推断执行来源。

## 入口模式

- `mode=direct`：用户显式调用授权。task-bound direct 可读取 task facts，但不要求 delegation receipt；taskless direct 只在 `TASK_CONTEXT_NOT_FOUND` 时允许，并跳过 task facts、review、task lock、checkpoint 和 task.md 收尾。
- `mode=orchestrated`：必须绑定明确 task，且 core 在第一个 Git 写入前验证匹配的 activated commit receipt、agent、stage、round、artifact、role 和未消费 capability。缺少任一项都返回 `blocked`，不写 Git。

## 共享执行顺序

1. 获取 repository/worktree mutation lock；task-bound 额外获取 task lock。
2. 验证 repository、当前 branch、明确 paths、敏感路径、staged scope、expected HEAD/tree、remote 和 full heads ref。
3. 完成模式对应的授权校验。
4. 最多创建一个本地 commit；无修改时只允许 push-only，不创建空 commit。
5. `main` / `master` 自动 push 返回 `COMMIT_AUTOPUSH_PROTECTED_BRANCH` warning；普通 push 失败返回 `COMMIT_PUSH_FAILED` warning，并保留本地事实。
6. 返回唯一主结果：`committed`、`no_op`、`committed_with_warnings`、`failed` 或 `blocked`。

## 重试边界

重跑重新读取当前 HEAD、worktree、branch 和 remote 事实。已有本地 commit 时只补 push，不创建第二个 commit；taskless 重跑不创建任何任务记录。orchestrated receipt 的 stage completion、seal 和 consume 由 orchestration core 负责，不由 direct 路径伪造。
