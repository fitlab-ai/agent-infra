---
description: "标记任务为阻塞状态并记录阻塞原因，将其从 active 目录移动到 blocked 目录。 当任务因技术问题、需求不清晰、缺少资源或待定决策而无法继续时使用。 参数：task-id，可选的阻塞原因。"
argument-hint: <task-id> [reason]
usage: /prompts:ai-collaboration-installer-block-task
---

阻塞任务：$ARGUMENTS

读取并执行 `.agents/skills/block-task/SKILL.md` 中的 block-task 技能。

严格按照技能中定义的所有步骤执行。
