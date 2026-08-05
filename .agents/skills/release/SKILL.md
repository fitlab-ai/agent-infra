---
name: release
description: >
  执行版本发布流程。
  当准备切出并发布新版本时使用。参数：版本号（X.Y.Z）。
---

# 版本发布

在单次调用中准备发布、展示最新事实快照并请求一次远端发布授权。状态由 Git、代码托管平台与包发布渠道事实重建，不维护第二套 journal。

## 1. 验证输入与人工检查点

验证唯一参数 `{version}` 是规范 SemVer，并读取最新 entropy 报告。报告存在未处置高风险项时停止；不得替用户批准发布。

## 2. 准备并检查发布事实

```bash
agent-infra-internal release-workflow inspect {version}
```

`blocked` 表示外部事实不可确认，不得当作 missing。若 snapshot 尚未 prepared，执行：

```bash
agent-infra-internal release-workflow prepare {version} --entropy-report {path}
```

prepare 后必须重新 inspect；already prepared 或 partially published 时直接使用当前事实，不重复已满足动作。

## 3. 展示快照并确认

完整展示最新 snapshot，并询问是否针对该快照发布。仅当前会话中无歧义的明确肯定答复授权步骤 4；否定、调整、疑问、歧义或会话中断均停止，不得 publish。快照变化时必须重新展示并重新确认。

## 4. 发布并复核

确认后执行：

```bash
agent-infra-internal release-workflow publish {version}
```

core 逐 ref 普通 push；部分成功保留并返回 degraded，重跑只补未满足事实，禁止 force push。操作后重新 inspect；unknown 必须 blocked。

## 5. 告知用户

只有复核 snapshot 已完整发布时，调用统一 helper 渲染下一步：

```bash
agent-infra-internal agent-client next-steps \
  --skill create-release-note \
  --version {version}
```

输出完整快照和 helper 的非空 stdout。不得显示内部 prepare/publish action，也不得直接跳到 post-release。
