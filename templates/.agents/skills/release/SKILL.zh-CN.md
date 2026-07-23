---
name: release
description: >
  执行版本发布流程。
  当准备切出并发布新版本时使用。参数：版本号（X.Y.Z）。
---

# 版本发布

发布由事实驱动，并拆为独立授权的 prepare 与 publish。

## 1. 检查输入与 entropy 报告

确认 SemVer 和人工发布检查点已满足。

## 2. 检查事实

```bash
agent-infra-internal release-workflow inspect {version}
```

## 3. 准备发布

```bash
agent-infra-internal release-workflow prepare {version} --entropy-report {path}
```

prepare 后停止，不得隐式 publish。

## 4. 独立发布

仅在用户明确授权后执行：

```bash
agent-infra-internal release-workflow publish {version}
```

逐 ref 普通 push；部分成功可重放，禁止 force push。

## 5. 输出事实摘要

完整展示 snapshot 和后续 TUI 命令；unknown 必须视为 blocked。
