---
name: post-release
description: >
  执行版本发布后的后处理工作。
  当版本已发布、需要执行发版后的收尾工作时使用。
---

# 发布后处理

## 1. 检查事实

要求用户显式提供唯一规范 SemVer `{version}`；不得回退到最新稳定 tag。然后执行：

```bash
agent-infra-internal release-workflow inspect {version}
```

平台 Release、npm、Homebrew 或 smoke 为 pending/unknown 时停止并报告 blocked；确定失败则报告 failed。

## 2. 执行后处理

```bash
agent-infra-internal release-workflow post {version}
```

core 负责 build、可选 demo、下一开发版本、内联产物、显式路径 commit 与普通 branch push；每次写后重新 inspect，重跑必须幂等。

core 在 prerelease bump 前计算 canonical demo inputs 摘要。摘要未变化时幂等跳过且不探测录制工具；变化时要求 Git LFS，并在 `vhs` 与 `ffmpeg` 可用时执行 `npm run demo:regen`。core 必须验证 GIF magic、4 MiB 上限和 LFS 跟踪，将 `assets/demo-init.gif` 与 `assets/demo-init.inputs.sha256` 纳入同一 post commit；录制、校验或 LFS 失败不得推进摘要。

## 3. 输出摘要

报告 released/new version、渠道事实、smoke、post commit 与 push 结果。不得把 degraded/blocked 表述为完成。
