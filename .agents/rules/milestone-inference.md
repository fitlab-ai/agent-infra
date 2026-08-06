# Milestone 推断规则

> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」：标准 AI 短名（`claude`/`codex`/`gemini`/`opencode`/`cursor`）、长名归一化（`claude-code`→`claude`、`gemini-cli`→`gemini`）或人工例外 `human`。

Milestone 继续按生命周期逐步收窄，但候选读取、分支判断、权限降级和写入统一由 `platform-issue` 处理。

## 阶段 1：创建或导入

```bash
agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --milestone initial
```

优先使用 task.md 中存在且有效的显式 milestone；否则从 open milestones 选择最低 `X.Y.x` 版本线，最后回退 `General Backlog`。`triage=false` 或外部事实不足时保持远端值并返回 skipped/degraded。

## 阶段 2：`code-task`

```bash
agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --milestone specific
```

版本线收窄规则保持不变：主干模式在当前版本线取最高 patch；多版本分支模式依据 release-line/main 祖先关系选择版本线。无法可靠判断时保持原值。完成门禁仍拒绝 `X.Y.x`。

## 阶段 3：`create-pr`

PR 只复用关联 Issue 的具体 milestone；该 PR 资源写入属于 09/10，不在 `platform-issue` 中实现。

调用方不得重新实现 milestone 列表、排序、分支祖先或 `gh issue edit` 逻辑。
