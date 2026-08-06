# Issue 创建

> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」：标准 AI 短名（`claude`/`codex`/`gemini`/`opencode`/`cursor`）、长名归一化（`claude-code`→`claude`、`gemini-cli`→`gemini`）或人工例外 `human`。

当 `create-task` 完成本地 `task.md` 落盘后，通过声明式内部命令创建 Issue：

```bash
agent-infra-internal platform-issue create {task-id} --agent {standard-agent-token}
```

命令只从已落盘 task.md 读取身份、标题、类型、描述与需求，并复用 `ai task issue-body` 的确定性正文渲染。它负责模板选择、upstream/capability、已有绑定检查、非幂等 POST 边界、响应身份校验及通过任务写入内核回写 `issue_number`。

创建后的初始元数据使用同一适配层同步：

```bash
agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} \
  --status waiting-for-triage --assignees current --milestone initial --issue-type --fields
```

## 结果处理

- `planned|applied|no-op|degraded`：exit 0；调用方按 operations 继续评论同步。
- `failed`：exit 1；调用方登记 `ISSUE_CREATE_FAILED` warning，不伪造绑定。
- `blocked`：exit 2；认证、网络或创建 outcome 不确定，调用方保留远端 identity 证据并停止盲目重试。
- 已绑定有效 Issue 时只验证绑定并返回 no-op，绝不重复创建。

自定义或空平台返回 no-op/degraded；调用方不得回退到直接 `gh issue` 或 GraphQL 编排。
