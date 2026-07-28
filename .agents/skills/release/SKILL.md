---
name: release
description: >
  执行版本发布流程。
  当准备切出并发布新版本时使用。参数：版本号（X.Y.Z）。
---

# 版本发布

把发布拆为明确授权的 prepare 与 publish 两个检查点。状态由 Git、代码托管平台与包发布渠道事实重建，不维护第二套 journal。

## 1. 验证输入与人工检查点

验证版本为 SemVer，并读取最新 entropy 报告。报告存在未处置高风险项时停止；不得替用户批准发布。

## 2. 检查发布事实

```bash
agent-infra-internal release-workflow inspect {version}
```

根据 `snapshot.phase` 报告已完成事实。`blocked` 表示外部事实不可确认，不得当作 missing。

## 3. 准备发布

用户本次调用只授权 prepare：

```bash
agent-infra-internal release-workflow prepare {version} --entropy-report {path}
```

core 负责 clean-tree/test、版本与内联产物、显式路径 commit 和本地 tag；操作后重新 inspect。完成后必须停止，不得隐式 publish。

## 4. 独立发布授权

只有用户随后明确要求 publish 时才执行：

```bash
agent-infra-internal release-workflow publish {version}
```

逐 ref 普通 push；部分成功保留并返回 degraded，重跑只补未满足事实，禁止 force push。

## 5. 告知用户

prepare 后展示 snapshot，并提示用户单独运行 release publish；publish 后根据 snapshot 提示等待渠道完成再运行 post-release。下一步客户端命令通过统一 helper 渲染。

## 注意事项

- prepare 不得触发 publish。
- 网络 unknown 必须 blocked。
- 不自动回滚已成功的远端 ref。
