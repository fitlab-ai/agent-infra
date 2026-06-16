---
description: "监控 PR 的 required checks 并在失败时自愈"
agent: general
subtask: false
---

监控 PR 检查：$ARGUMENTS

读取并执行 `.agents/skills/watch-pr/SKILL.md` 中的 watch-pr 技能。

严格按照技能中定义的所有步骤执行。
