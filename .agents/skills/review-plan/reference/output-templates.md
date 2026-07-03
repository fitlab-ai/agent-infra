# 审查输出模板

在向用户汇报最终审查结论之前先读取本文件。

## 选择唯一输出场景

按以下顺序判断（**注意：manual-validation 数量不参与判断**）：
1. 如果 `Blocker = 0` 且 `Major = 0` 且 `Minor = 0`，使用场景 A（不管 manual-validation 是否 > 0）
2. 如果 `Blocker = 0` 且（`Major > 0` 或 `Minor > 0`），使用场景 B
3. 如果 `Blocker > 0`，且问题可以通过一次聚焦修复解决，使用场景 C
4. 如果技术方案需要重大重构、大范围重写或整体重来，使用场景 D

禁止规则：
- 不要跳过场景判断步骤
- 不要混用不同场景的文案
- 只要 `Blocker > 0`，就绝对不能输出通过模板
- manual-validation 项绝对不能被计入 blocker / major / minor 计数，也不能用作触发场景 B/C/D 的依据
- 所选场景中必须包含所有 TUI 命令格式
- 计数行固定显示 4 个数字：前三项（阻塞 / 主要 / 次要）必须为 0 才进下一步；第四项 `人工裁决`（`{h}`）= task.md `## 审查分歧账本` 中 `stage=plan` 且 `status=needs-human-decision` 的行数，是「待人裁」项、不要求归零，也不参与场景判断。当 `{h} > 0` 时，必须在选定场景的「下一步」命令之前，按 `.agents/rules/next-step-output.md`「人工裁决待办前置块」逐项展开裁决项并提示先完成裁决

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

### 场景 B：通过但有问题

```text
任务 {task-id} 技术方案审查完成。结论：通过。
- 阻塞项：0 | 主要问题：{n} | 次要问题：{n} | 人工裁决：{h}
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 修订方案后编码（推荐）：
  - Claude Code / OpenCode：/plan-task {task-ref}
  - Gemini CLI：/agent-infra:plan-task {task-ref}
  - Codex CLI：$plan-task {task-ref}

或直接进入编码：
  - Claude Code / OpenCode：/code-task {task-ref}
  - Gemini CLI：/agent-infra:code-task {task-ref}
  - Codex CLI：$code-task {task-ref}

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
