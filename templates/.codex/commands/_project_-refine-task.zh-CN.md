---
description: "处理代码审查反馈并修复审查中发现的问题。按优先级（Blocker -> Major -> Minor）修复。 仅处理审查中标记的问题，不添加额外变更。当用户要求修复审查问题时触发。参数：task-id。"
argument-hint: <task-id>
usage: /prompts:{project}-refine-task
---

修复任务 $1 的审查问题。

读取并执行 `.agents/skills/refine-task/SKILL.md` 中的 refine-task 技能。

严格按照技能中定义的所有步骤执行。
