---
description: "根据用户的自然语言描述创建任务并执行需求分析。当用户描述一个新功能、Bug 或改进需求时触发。 唯一的产出是 task.md 和 analysis.md —— 不编写任何业务代码。参数：任务描述文本。"
usage: "/create-task <description>"
---

读取并执行 `.agents/skills/create-task/SKILL.md` 中的 create-task 技能。

严格按照技能中定义的所有步骤执行。
