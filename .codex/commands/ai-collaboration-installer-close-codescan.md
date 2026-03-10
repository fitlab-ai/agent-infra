---
description: "关闭 Code Scanning（CodeQL）告警并提供有据可查的理由。 当用户要求关闭 Code Scanning 告警时触发。参数：告警编号。"
argument-hint: <alert-number>
usage: /prompts:ai-collaboration-installer-close-codescan
---

关闭 CodeQL 告警 #$1。

读取并执行 `.agents/skills/close-codescan/SKILL.md` 中的 close-codescan 技能。

严格按照技能中定义的所有步骤执行。
