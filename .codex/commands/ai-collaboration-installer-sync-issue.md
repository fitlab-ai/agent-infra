---
description: "将任务处理进度同步到对应的 GitHub Issue 评论。 当用户要求同步进度到 Issue 时触发。参数：task-id。"
argument-hint: <task-id>
usage: /prompts:ai-collaboration-installer-sync-issue
---

同步任务 $1 到 Issue。

读取并执行 `.agents/skills/sync-issue/SKILL.md` 中的 sync-issue 技能。

严格按照技能中定义的所有步骤执行。
