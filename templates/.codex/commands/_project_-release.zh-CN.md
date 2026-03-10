---
description: "执行版本发布流程。当用户要求发布版本时触发。参数：版本号（X.Y.Z）。"
argument-hint: <version>
usage: /prompts:{project}-release
---

发布版本 $1。

读取并执行 `.agents/skills/release/SKILL.md` 中的 release 技能。

严格按照技能中定义的所有步骤执行。
