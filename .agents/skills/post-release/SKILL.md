---
name: post-release
description: >
  执行版本发布后的后处理工作。
  当版本已发布、需要执行发版后的收尾工作时使用。
---

# 发布后处理

## 1. 检查事实

从用户给出的版本或最新稳定 tag 得到 `{version}`，然后执行：

```bash
agent-infra-internal release-workflow inspect {version}
```

平台 Release、npm、Homebrew 或 smoke 为 pending/unknown 时停止并报告 blocked；确定失败则报告 failed。

## 2. 执行后处理

```bash
agent-infra-internal release-workflow post {version}
```

core 负责 build、可选 demo、下一开发版本、内联产物、显式路径 commit 与普通 branch push；每次写后重新 inspect，重跑必须幂等。

当前项目在 `vhs` 与 `ffmpeg` 可用时会于 prerelease bump 前执行 `npm run demo:regen`。core 必须验证 `assets/demo-init.gif` 已生成，并在文件发生变化时将其纳入 post commit；输出摘要需报告 demo 状态与路径。缺少录制工具时允许明确跳过，录制命令失败或输出缺失时必须失败。

## 3. 输出摘要

报告 released/new version、渠道事实、smoke、post commit 与 push 结果。不得把 degraded/blocked 表述为完成。
