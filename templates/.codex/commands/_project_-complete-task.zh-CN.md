---
description: "标记任务完成并归档，将任务目录从 active/ 移动到 completed/。在允许完成之前， 验证所有工作流步骤已完成、代码已审查并提交、测试已通过。 当用户要求完成或归档任务时触发。参数：task-id。"
argument-hint: <task-id>
usage: /prompts:{project}-complete-task
---

完成任务 $1。

读取并执行 `.agents/skills/complete-task/SKILL.md` 中的 complete-task 技能。

严格按照技能中定义的所有步骤执行。
