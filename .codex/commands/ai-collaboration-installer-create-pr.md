---
description: "创建 Pull Request 到指定或自动推断的目标分支。 当用户要求创建 PR 时触发。可选参数：目标分支。"
argument-hint: [target-branch]
usage: /prompts:ai-collaboration-installer-create-pr
---

创建 PR：$ARGUMENTS

读取并执行 `.agents/skills/create-pr/SKILL.md` 中的 create-pr 技能。

严格按照技能中定义的所有步骤执行。
