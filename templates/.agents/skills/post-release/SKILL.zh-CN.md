---
name: post-release
description: >
  执行版本发布后的后处理工作。
  当版本已发布、需要执行发版后的收尾工作时使用。
---

# 发布后处理

要求用户显式提供唯一规范 SemVer `{version}`，不得回退到最新 tag。

## 1. 检查渠道事实

```bash
agent-infra-internal release-workflow inspect {version}
```

pending/unknown 必须 blocked，确定失败必须 failed。`complete` 直接按外部事实报告完成。

## 2. 准备本地后处理

尚未完成时执行：

```bash
agent-infra-internal release-workflow post-prepare {version}
agent-infra-internal release-workflow inspect {version}
```

core 负责 build、可选 demo、下一开发版本、内联产物和显式路径 post commit；该动作不得 push。重跑从 Git 与渠道事实恢复，不重复已完成操作。

## 3. 检查确认快照

- `complete`：报告完成，不询问、不 publish。
- 存在 `postConfirmation`：展示完整字段和 `sha256`，进入步骤 4。
- 不存在 `postConfirmation`：报告 `isHead=false`、工作树或暂存区非空等诊断并停止，不询问、不 publish。

## 4. 获取当前快照授权

仅在当前会话已展示完整 `postConfirmation` 后询问一次是否发布。只有无歧义肯定答复才继续；否定、调整、疑问、歧义或中断均停止。授权不跨会话或快照复用。

## 5. 发布已确认快照

```bash
agent-infra-internal release-workflow post-publish {version} \
  --expected-sha256 "{post-confirmation-sha256}"
```

core 重新 inspect 并校验摘要后仅执行普通 branch push，禁止 force push。摘要漂移时停止并回到步骤 1 重新展示、重新确认。

## 6. 写后复核并报告

```bash
agent-infra-internal release-workflow inspect {version}
```

报告全部渠道、released/new version、smoke、post commit 与远端 branch 事实；只有阶段为 `complete` 才表述为完成，不把 failed/degraded/blocked 表述为成功。
