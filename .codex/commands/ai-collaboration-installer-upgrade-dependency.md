---
description: "升级项目中的指定依赖包到新版本并验证变更。 当用户要求升级依赖时触发。参数：包名、原版本和新版本。"
argument-hint: <pkg> <from> <to>
usage: /prompts:ai-collaboration-installer-upgrade-dependency
---

升级依赖：$ARGUMENTS

读取并执行 `.agents/skills/upgrade-dependency/SKILL.md` 中的 upgrade-dependency 技能。

严格按照技能中定义的所有步骤执行。
