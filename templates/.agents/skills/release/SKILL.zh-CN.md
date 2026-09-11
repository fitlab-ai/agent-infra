---
name: release
description: >
  执行版本发布流程。
  当准备切出并发布新版本时使用。参数：版本号（X.Y.Z）。
---

# 版本发布

在单次调用中准备发布、展示最新事实快照并请求一次远端发布授权。状态由外部事实重建。

## 1. 验证输入与人工检查点

验证唯一参数 `{version}` 是规范 SemVer，并确认 entropy 人工检查点已满足。

## 2. 准备并检查发布事实

```bash
agent-infra-internal release-workflow inspect {version}
```

保留并展示该命令的完整非空 stdout。未 prepared 时执行 prepare 并重新 inspect；已准备或部分发布时复用当前事实。unknown 必须 blocked。

```bash
agent-infra-internal release-workflow prepare {version} --entropy-report {path}
```

展示 prepare 的 `status`、`error` 和 `operations`，包括里程碑关闭与后续里程碑创建结果。`failed` 或 `blocked` 时停止，不得请求发布授权；只有 prepare 成功且重新 inspect 得到的最新快照才可继续。

prepare 后必须重新 inspect。

## 3. 展示快照并确认

展示最新 snapshot 的完整 JSON，包括所有渠道状态。只有当前会话中针对该快照的无歧义明确肯定答复才授权发布；否定、调整、疑问、歧义或中断均停止。快照变化后重新确认。

## 4. 发布并复核

```bash
agent-infra-internal release-workflow publish {version}
```

逐 ref 普通 push；部分成功可重放，禁止 force push。操作后重新 inspect，并明确列出仍未完成的平台 Release、npm、Homebrew 或 smoke 项。

## 5. 输出事实摘要

完整发布后渲染携带版本的下一步，不显示内部 action，也不直接跳到 post-release：

```bash
agent-infra-internal agent-client next-steps \
  --skill create-release-note \
  --version {version}
```
