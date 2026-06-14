# 任务状态更新

在选择提交后的任务状态分支之前先读取本文件。

更新任务元数据前，先读取 `.agents/rules/version-stamp.md`，并随 `updated_at` 一起刷新 `agent_infra_version`。

## 更新关联任务状态

先获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

对于每一次与任务相关的提交，都要在 `task.md` 中追加以下 Activity Log：

```text
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Commit** by {agent} — {commit hash short} {commit subject}
```

在决定下一步之前，先确认：
- `task.md` 中的 `current_step` 和最新工作流进度
- 最新的 `review-code.md` / `review-code-r{N}.md` 是否无问题通过
- 是否仍然存在待修复项、待审查工作或待创建 PR 的步骤

**门控读取（项目级 PR 流程策略）**：在执行本步骤前，读取 `.agents/.airc.json` 的 `requiresPullRequest` 字段；当字段缺失或为 `true` 时视为「启用 PR 流程」（默认），仅当显式为 `false` 时视为「关闭 PR 流程」。所有依赖该字段的分支按此规则判定。

必须且只能选择一个分支：

| 判断依据 | 必选分支 |
|---|---|
| 所有工作流步骤都已完成 + 最新审查无问题通过 + 所有测试通过 | 场景 1：最终提交 |
| 仍有未完成步骤、待修复项或等待他人的动作 | 场景 2：还有后续工作 |
| 这次提交是为了把任务交给代码审查 | 场景 3：准备进入审查 |
| 代码已提交、审查已完成，且**项目启用 PR 流程**，下一步是创建 PR | 场景 4：准备创建 PR |

绝对不要同时套用多个分支。先匹配唯一的下一步分支，再更新任务。

**门控降级**：当 `requiresPullRequest === false` 时，场景 4 永远不被进入；原本会落入场景 4 的提交统一收敛到场景 1（最终提交 → `/complete-task`）。

### 场景 1：最终提交

前置条件：
- [ ] 所有代码都已提交
- [ ] 所有测试通过
- [ ] 代码审查已通过
- [ ] 所有工作流步骤已完成（对 yaml `commit` 步骤的 `pr_tasks` 列表，仅在 `requiresPullRequest !== false` 时计入）

必带下一步命令：

```text
下一步 - 完成并归档任务：
  - Claude Code / OpenCode: /complete-task {task-ref}
  - Gemini CLI: /agent-infra:complete-task {task-ref}
  - Codex CLI: $complete-task {task-ref}
```

### 场景 2：还有后续工作

如果仍有工作待完成：
- 更新 `task.md` 中的 `updated_at`
- 按 `.agents/rules/version-stamp.md` 更新 `agent_infra_version`
- 记录这次提交完成了什么
- 记录下一位人类或 agent 需要继续做什么

### 场景 3：准备进入审查

如果这次提交把工作移交给代码审查：
- 将 `current_step` 更新为 `code-review`
- 更新 `updated_at`
- 按 `.agents/rules/version-stamp.md` 更新 `agent_infra_version`
- 在工作流状态中标记实现阶段已完成

必带下一步命令：

```text
下一步 - 代码审查：
  - Claude Code / OpenCode: /review-code {task-ref}
  - Gemini CLI: /agent-infra:review-code {task-ref}
  - Codex CLI: $review-code {task-ref}
```

### 场景 4：准备创建 PR

如果下一步是创建 Pull Request：
- 更新 `updated_at`
- 按 `.agents/rules/version-stamp.md` 更新 `agent_infra_version`
- 在 `task.md` 中记录 PR 计划

必带下一步命令：

```text
下一步 - 创建 Pull Request：
  - Claude Code / OpenCode: /create-pr {task-ref}
  - Gemini CLI: /agent-infra:create-pr {task-ref}
  - Codex CLI: $create-pr {task-ref}
```

> 注意：四个场景之外，只要 `task.md` 中存在有效 `pr_number`，commit 技能必须先按 `reference/pr-summary-sync.md` 同步 PR 摘要，再进入完成校验。
