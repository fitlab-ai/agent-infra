---
name: post-release
description: >
  执行版本发布后的后处理工作。
  当版本已发布、需要执行发版后的收尾工作时使用。
---

# 发布后处理

## 1. 检查渠道事实

```bash
agent-infra-internal release-workflow inspect {version}
```

pending/unknown 必须 blocked，确定失败必须 failed。

## 2. 执行后处理

```bash
agent-infra-internal release-workflow post {version}
```

core 负责 build、下一开发版本、内联产物、显式路径 commit 与普通 push，并在写后复核。

## 3. 输出摘要

报告全部渠道、smoke、commit 与 push 事实，不把 degraded/blocked 表述为完成。
