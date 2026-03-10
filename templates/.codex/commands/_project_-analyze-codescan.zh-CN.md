---
description: "分析 Code Scanning（CodeQL）告警，评估安全风险，并创建修复任务。 当用户要求分析 Code Scanning 告警时触发。参数：告警编号。"
argument-hint: <alert-number>
usage: /prompts:{project}-analyze-codescan
---

分析 CodeQL 告警 #$1。

读取并执行 `.agents/skills/analyze-codescan/SKILL.md` 中的 analyze-codescan 技能。

严格按照技能中定义的所有步骤执行。
