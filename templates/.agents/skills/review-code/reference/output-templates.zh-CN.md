# 审查输出模板

在向用户汇报最终审查结论之前先读取本文件。

> 本文件描述的是**用户回执文本**的 4 个分类（场景 A/B/C/D），用于「向用户汇报结论」步骤。它**不是** review-code 产物的 `**总体结论**：` 字段值——字段值固定为 3 个规范 token（`通过` / `需要修改` / `拒绝`，或 EN 对应 `Approved` / `Changes Requested` / `Rejected`）。两者不可混用。

## 选择唯一输出场景

按 `stage-status` 结果判断（**注意：manual-validation 和 advisory 数量不参与判断**）：
1. 如果 `stageStatus.canAdvance=true`，使用场景 A
2. 如果 `stageStatus.canAdvance=false` 且无 blocker，使用场景 B
3. 如果 `Blocker > 0`，且问题可以通过一次聚焦修复解决，使用场景 C
4. 如果任务需要重大重构、大范围重写或整体重来，使用场景 D

禁止规则：
- 不要跳过场景判断步骤
- 不要混用不同场景的文案
- 只要 `Blocker > 0`，就绝对不能输出通过模板
- manual-validation 项绝对不能被计入 blocker / major / minor 计数，也不能用作触发场景 B/C/D 的依据
- 所选场景中必须包含所有 TUI 命令格式
- 计数行固定显示 5 个数字。manual-validation（`{e}`）不影响分支；`人工裁决`（`{h}`）是本阶段 `needs-human-decision` 行数，属于未闭环账本状态，因此 `{h} > 0` 时 `canAdvance=false`，必须按 `.agents/rules/next-step-output.md` 的「人工裁决待办前置块」展开详情，并只输出修订与复审路径。

场景 B/C/D 在修订命令后继续列出复审命令：`/review-code {task-ref}`、`/{{project}}:review-code {task-ref}`、`$review-code {task-ref}`。

### 场景 A：通过且无问题

通过后不得按轮次路由。先比较审查快照树 `T` 与基线 `R` 的树，再读取任务的 `prFlow` / `pr_number`；存在 PR 时调用 `agent-infra-internal platform-checks inspect {task-id}`。只选择以下一个互斥出口：

- `T != R^{tree}`：场景 A1（提交）。
- `T == R^{tree}` 且无 PR：`prFlow=disabled` 用场景 A4（完成），否则用场景 A2（创建 PR）。
- 已有 PR 但 PR head != `R`：场景 A1（提交/推送）。
- PR head = `R`，checks 为 `pending|failed|cancelled` 或平台暂不可用：场景 A3（监控），不得输出完成命令。
- PR head = `R`，checks 为 `passed|no-required`：场景 A4（完成）。

场景 A 的共同摘要：

```text
任务 {task-id} 代码审查完成。结论：通过。
- 阻塞项：0 | 主要问题：0 | 次要问题：0 | 人工校验点：{e} | 人工裁决：{h}
[- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}]

[当 manual-validation > 0 时，在最后附加一行：]
提醒：manual-validation 项需在 PR description 的「待人工验证」清单中承接，不应触发 /code-task。
```

#### 场景 A1：提交或推送

```text
下一步 - 提交或推送代码：
  - Claude Code / OpenCode：/commit {task-ref}
  - Gemini CLI：/{{project}}:commit {task-ref}
  - Codex CLI：$commit {task-ref}
```

#### 场景 A2：创建 Pull Request

```text
下一步 - 创建 Pull Request：
  - Claude Code / OpenCode：/create-pr {task-ref}
  - Gemini CLI：/{{project}}:create-pr {task-ref}
  - Codex CLI：$create-pr {task-ref}
```

#### 场景 A3：监控 required checks

```text
下一步 - 监控 PR 检查：
  - Claude Code / OpenCode：/watch-pr {task-ref}
  - Gemini CLI：/{{project}}:watch-pr {task-ref}
  - Codex CLI：$watch-pr {task-ref}
```

#### 场景 A4：完成并归档

```text
下一步 - 完成并归档任务：
  - Claude Code / OpenCode：/complete-task {task-ref}
  - Gemini CLI：/{{project}}:complete-task {task-ref}
  - Codex CLI：$complete-task {task-ref}
```

### 场景 B：需要修改（major / minor）

```text
任务 {task-id} 代码审查完成。结论：需要修改。
- 阻塞项：0 | 主要问题：{n} | 次要问题：{n} | 人工校验点：{e} | 人工裁决：{h}
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 修复问题：
  - Claude Code / OpenCode：/code-task {task-ref}
  - Gemini CLI：/{{project}}:code-task {task-ref}
  - Codex CLI：$code-task {task-ref}

[当 manual-validation > 0 时，在最后附加一行：]
提醒：manual-validation 项需在 PR description 的「待人工验证」清单中承接，不应触发 /code-task。
```

### 场景 C：需要修改

```text
任务 {task-id} 代码审查完成。结论：需要修改。
- 阻塞项：{n} | 主要问题：{n} | 次要问题：{n} | 人工校验点：{e} | 人工裁决：{h}
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 修复问题：
  - Claude Code / OpenCode：/code-task {task-ref}
  - Gemini CLI：/{{project}}:code-task {task-ref}
  - Codex CLI：$code-task {task-ref}

[当 manual-validation > 0 时，在最后附加一行：]
提醒：manual-validation 项需在 PR description 的「待人工验证」清单中承接，不应触发 /code-task。
```

### 场景 D：拒绝

```text
任务 {task-id} 代码审查完成。结论：拒绝，需要重新设计方案。
- 阻塞项：{n} | 主要问题：{n} | 次要问题：{n} | 人工校验点：{e} | 人工裁决：{h}
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 重新设计技术方案：
  - Claude Code / OpenCode：/plan-task {task-ref}
  - Gemini CLI：/{{project}}:plan-task {task-ref}
  - Codex CLI：$plan-task {task-ref}

> 注意：Rejected 表示实现方向需要整体重做，不是局部修复。核心 artifact lifecycle 的分支 #7 会拒绝直接 `/code-task`，要求先重新方案设计。

[当 manual-validation > 0 时，在最后附加一行：]
提醒：manual-validation 项需在 PR description 的「待人工验证」清单中承接，不应触发 /code-task。
```
