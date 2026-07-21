# 审查输出模板

在向用户汇报最终审查结论之前先读取本文件。

## 选择唯一输出场景

按 `stage-status` 结果判断（**注意：manual-validation 和 advisory 数量不参与判断**）：
1. 如果 `stageStatus.canAdvance=true`，使用场景 A
2. 如果 `stageStatus.canAdvance=false` 且无 blocker，使用场景 B
3. 如果 `Blocker > 0`，且问题可以通过一次聚焦修复解决，使用场景 C
4. 如果技术方案需要重大重构、大范围重写或整体重来，使用场景 D

禁止规则：
- 不要跳过场景判断步骤
- 不要混用不同场景的文案
- 只要 `Blocker > 0`，就绝对不能输出通过模板
- manual-validation 项绝对不能被计入 blocker / major / minor 计数，也不能用作触发场景 B/C/D 的依据
- 所选场景中必须包含所有 TUI 命令格式
- 计数行固定显示 4 个数字。`人工裁决`（`{h}`）是本阶段 `needs-human-decision` 行数；它属于未闭环账本状态，因此 `{h} > 0` 时 `canAdvance=false`，必须按 `.agents/rules/next-step-output.md` 的「人工裁决待办前置块」展开详情，并只输出修订与复审路径。

场景 B/C/D 在修订命令后继续列出复审命令：`/review-plan {task-ref}`、`/agent-infra:review-plan {task-ref}`、`$review-plan {task-ref}`。

### 场景 A：通过且无问题

```text
任务 {task-id} 技术方案审查完成。结论：通过。
- 阻塞项：0 | 主要问题：0 | 次要问题：0 | 人工裁决：{h}
[- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}]

下一步 - 编写代码：
  - Claude Code / OpenCode：/code-task {task-ref}
  - Gemini CLI：/agent-infra:code-task {task-ref}
  - Codex CLI：$code-task {task-ref}

[当 manual-validation > 0 时，在最后附加一行：]
提醒：manual-validation 项需在 PR description 的「待人工验证」清单中承接，不应触发 /plan-task。
```

### 场景 B：需要修改（major / minor）

```text
任务 {task-id} 技术方案审查完成。结论：需要修改。
- 阻塞项：0 | 主要问题：{n} | 次要问题：{n} | 人工裁决：{h}
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 修订技术方案：
  - Claude Code / OpenCode：/plan-task {task-ref}
  - Gemini CLI：/agent-infra:plan-task {task-ref}
  - Codex CLI：$plan-task {task-ref}

[当 manual-validation > 0 时，在最后附加一行：]
提醒：manual-validation 项需在 PR description 的「待人工验证」清单中承接，不应触发 /plan-task。
```

### 场景 C：需要修改

```text
任务 {task-id} 技术方案审查完成。结论：需要修改。
- 阻塞项：{n} | 主要问题：{n} | 次要问题：{n} | 人工裁决：{h}
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 修订技术方案：
  - Claude Code / OpenCode：/plan-task {task-ref}
  - Gemini CLI：/agent-infra:plan-task {task-ref}
  - Codex CLI：$plan-task {task-ref}

[当 manual-validation > 0 时，在最后附加一行：]
提醒：manual-validation 项需在 PR description 的「待人工验证」清单中承接，不应触发 /plan-task。
```

### 场景 D：拒绝

```text
任务 {task-id} 技术方案审查完成。结论：拒绝，需要重新设计。
- 阻塞项：{n} | 主要问题：{n} | 次要问题：{n} | 人工裁决：{h}
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 重新设计：
  - Claude Code / OpenCode：/plan-task {task-ref}
  - Gemini CLI：/agent-infra:plan-task {task-ref}
  - Codex CLI：$plan-task {task-ref}

[当 manual-validation > 0 时，在最后附加一行：]
提醒：manual-validation 项需在 PR description 的「待人工验证」清单中承接，不应触发 /plan-task。
```
