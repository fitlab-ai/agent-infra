---
description: "审查任务实现代码并输出代码审查报告，按严重程度分类（Blocker / Major / Minor）。 当用户在实现完成后要求代码审查时触发。参数：task-id。"
argument-hint: <task-id>
usage: /prompts:ai-collaboration-installer-review-task
---

审查任务 $1。

读取并执行 `.agents/skills/review-task/SKILL.md` 中的 review-task 技能。

严格按照技能中定义的所有步骤执行。
