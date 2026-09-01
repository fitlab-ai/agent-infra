# 安全告警

在导入或关闭依赖告警、代码扫描告警前，先阅读本规则。

## 共享入口

所有调用方都使用共享安全脚本，并解析其单个 JSON 结果：

```text
bash .agents/scripts/security-alerts.sh read-dependabot --number {number}
bash .agents/scripts/security-alerts.sh dismiss-dependabot --number {number} --reason {api-reason} --comment-file {file}
bash .agents/scripts/security-alerts.sh read-codescan --number {number}
bash .agents/scripts/security-alerts.sh dismiss-codescan --number {number} --reason {api-reason} --comment-file {file}
```

结果包含 `status`、`operation`，以及 `data` 或 `error.code` 与 `error.message`。`status` 只能是 `applied`、`no-op`、`degraded` 或 `failed`。诊断信息写入 stderr；stdout 必须只包含一个 JSON 对象。

任何关闭操作前都必须先读取当前告警。关闭原因必须使用 provider API 的 reason 值，生成的任务或 Issue 评论必须通过 `--comment-file` 传入。

SKILL 不得直接调用 provider CLI。degraded 或 failed 结果必须如实报告，取消或失败的操作不得记录为成功。
