# 安全告警

在导入或关闭依赖告警、代码扫描告警前，先阅读本规则。

## 共享意图入口

所有调用方都使用 runtime security intent，并解析其单个 JSON 结果：

```text
agent-infra-internal platform-security read --kind dependabot --number {number}
agent-infra-internal platform-security dismiss --kind dependabot --number {number} --reason {reason} --comment-file {file}
agent-infra-internal platform-security read --kind code-scanning --number {number}
agent-infra-internal platform-security dismiss --kind code-scanning --number {number} --reason {reason} --comment-file {file}
```

结果包含 `status`、`operation`，以及 `data` 或 `error.code` 与 `error.message`。`status` 只能是 `applied`、`no-op`、`degraded` 或 `failed`。诊断信息写入 stderr；stdout 必须只包含一个 JSON 对象。

任何关闭操作前都必须先读取当前告警。关闭原因由 runtime intent 作为结构化输入校验，生成的任务或 Issue 评论必须通过 `--comment-file` 传入。

SKILL 不得直接执行平台命令或实现平台状态机。degraded 或 failed 结果必须如实报告，取消或失败的操作不得记录为成功。
