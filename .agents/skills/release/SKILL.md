---
name: release
description: >
  执行版本发布流程。
  当准备切出并发布新版本时使用。参数：版本号（X.Y.Z）。
---

# 版本发布

在单次调用中准备发布、展示最新事实快照并请求一次远端发布授权。状态由外部事实重建；具体以 Git、代码托管平台与包发布渠道为准，不维护第二套 journal。

## 1. 验证输入与人工检查点

验证唯一参数 `{version}` 是规范 SemVer，并确认 entropy 人工检查点已满足。为此读取最新 entropy 报告；报告存在未处置高风险项时停止，不得替用户批准发布。

## 2. 准备并检查发布事实

```bash
agent-infra-internal release-workflow inspect {version}
```

必须保留并展示该命令的完整非空 stdout。`blocked` 表示外部事实不可确认，不得当作 missing。未 prepared 时执行 prepare 并重新 inspect；已准备或部分发布时复用当前事实。unknown 必须 blocked。

```bash
agent-infra-internal release-workflow prepare {version} --entropy-report {path}
```

必须展示 prepare 的 `status`、`error` 和 `operations`，其中包括关闭当前版本里程碑及创建后续规划里程碑的结果。`failed` 或 `blocked` 时停止，不得请求发布授权；只有 prepare 成功且重新 inspect 得到的最新快照才可进入下一步。

prepare 后必须重新 inspect；不得重复已满足动作。

## 3. 展示快照并确认

展示最新 snapshot 的完整 JSON，包括 `facts` 中的所有渠道状态。只有当前会话中针对该快照的无歧义明确肯定答复才授权发布；否定、调整、疑问、歧义或中断均停止，不得 publish。快照变化后重新展示并重新确认。

## 4. 发布并复核

```bash
agent-infra-internal release-workflow publish {version}
```

逐 ref 普通 push；部分成功可重放，禁止 force push。core 保留已成功事实并返回 degraded，重跑只补未满足事实。操作后重新 inspect；unknown 必须 blocked。发布后的 inspect 必须展示完整快照；如果平台 Release、npm、Homebrew 或 smoke 仍为 pending，明确标出未完成项，不得把 Git ref 推送成功表述为完整发布。

## 5. 输出事实摘要

完整发布后渲染携带版本的下一步，不显示内部 action，也不直接跳到 post-release：

```bash
agent-infra-internal agent-client next-steps \
  --skill create-release-note \
  --version {version}
```

输出完整快照和 helper 的非空 stdout。
