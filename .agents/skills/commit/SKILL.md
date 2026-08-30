---
name: commit
description: >
  提交当前变更到 Git。
  当需要把已完成的工作落为一次 Git 提交时使用。
---

# 提交代码

> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」。

在不覆盖用户本地工作的前提下创建 Git commit，并在需要时更新关联任务状态。

commit core 只返回一个主结果：`committed`、`no_op`、`committed_with_warnings`、`failed` 或 `blocked`，并附带结构化 `warnings`。push 失败或保护分支策略不会撤销已经创建的本地提交。

## 任务上下文

入口允许省略 task ref，也接受旧位置 task ref 或 `--task <ref>` / `-t <ref>`。先调用 `agent-infra-internal task-context resolve {task-scope}`。

- 显式 task scope 解析失败时停止。
- 未显式指定 task scope 时，只有 `TASK_CONTEXT_NOT_FOUND` 可进入 taskless direct；detached HEAD、损坏候选或多匹配必须 fail closed。
- 入口业务操作数包含字面 `--orchestrated` 时使用 `mode=orchestrated`，否则使用 `mode=direct`；不得从 run 文件或环境推断模式。
- taskless direct 不读取、创建或完成 task intent、receipt、checkpoint 或 task.md 收尾记录。
- task-bound direct 不要求 delegation receipt；orchestrated 必须由 core 验证匹配的 activated commit receipt 和 capability。
- 解析成功后只使用 core 返回的 `taskId`；不得从环境、分支或文件名猜测任务身份。

## 1. 检查本地修改

在任何编辑前先检查：

```bash
git status --short
git diff
```

必须尊重现有用户改动；如果计划与之冲突，按禁言规则停止并记录阻塞原因。

## 2. 更新版权头年份

动态获取当前年份，只更新已经改动过的带版权头文件。完整流程见 `reference/copyright-check.md`。

## 3. 生成提交信息

检查状态、diff 和最近历史，按 Conventional Commits 生成英文祈使句 message，并读取 `reference/commit-message.md` 处理协作署名。

## 4. 调用唯一 commit core

执行本步骤前读取 `reference/commit-orchestration.md`。

将 message、明确 paths、expected HEAD/tree、task scope、agent、mode 和必填 push policy 写入临时 JSON，然后调用：

```bash
agent-infra-internal git-workflow commit --input {commit-operation.json}
```

示例：

```json
{
  "taskRef": "TASK-YYYYMMDD-HHMMSS",
  "agent": "codex",
  "mode": "direct",
  "paths": ["lib/example.ts", "tests/example.test.ts"],
  "message": "fix(core): validate example input",
  "expectedHead": "{HEAD}",
  "expectedTree": "{TREE}",
  "push": {
    "remote": "origin",
    "refs": ["refs/heads/{branch}"]
  }
}
```

taskless direct 省略 `taskRef`；orchestrated 必须显式传 `taskRef`、`agent` 和 `mode: "orchestrated"`。core 统一负责 repository/worktree mutation lock、task lock（仅 task-bound）、路径和敏感文件、staged scope、HEAD/tree、branch/ref、commit、push、保护分支、warning 和幂等校验。

- 有明确修改时最多创建一个本地 commit。
- 无修改但需要交付本地领先的 HEAD 时只执行 push-only，不创建空 commit。
- `main` / `master` 的自动 push 跳过并返回 `COMMIT_AUTOPUSH_PROTECTED_BRANCH`；本地 commit 保留。
- 普通 push 失败返回 `COMMIT_PUSH_FAILED` warning；重跑只补当前 push，不重复创建 commit。
- taskless 成功不写 task.md、review、receipt、checkpoint 或 Activity Log。

## 5. 任务收尾与平台同步

task-bound 操作按 core 返回的 task 结果继续执行任务同步；taskless 操作跳过任务校验和任务平台同步。

当 task 存在且关联 Issue/PR 时，按 `reference/issue-metadata-sync.md`、`reference/pr-summary-sync.md` 和平台规则执行同步；commit 路径调用 summary-sync 时固定传入 `--result no_op`，因为它只同步已有 PR 身份。同步失败只产生 warning，不撤销本地 commit。

完成 task-bound 收尾后运行：

```bash
date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
agent-infra-internal task-verify {task-id} commit.completed --format text
```

没有当次校验输出，不得声明任务收尾完成。

## 6. 输出下一步

渲染下一步前先读取 `.agents/rules/next-step-output.md`，并根据最新 task/PR 状态只调用一次统一 helper。push 失败时保持任务 active，只输出诊断；最终提交则按 `prFlow` 选择 `create-pr` 或 `complete-task`。

## 注意事项

- 不要提交 `.env`、凭据、密钥等敏感文件。
- 不要使用 `git add -A` 或 `git add .`。
- 不要手写 task Activity Log、review anchor、receipt 或 checkpoint。
