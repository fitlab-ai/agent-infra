# 外部 PR 交付

本场景只适用于 completion canonical inventory 为空、实现实际由已合并的外部 PR 交付的 active 任务。

## Typed 状态机

调用 `agent-infra-internal platform-pr resolve-external {task-id} --agent {agent} [--pr {N}]`。core 先检查 completion inventory；非空时返回 `mode=normal`，且显式 `--pr` 会失败。空 inventory 必须有正整数 `issue_number`，否则返回 `EXTERNAL_DELIVERY_ISSUE_REQUIRED`。

core 通过平台 adapter 读取 Issue 的权威 closing change requests，穷尽分页后只把 base 仓库匹配任务仓库且已经合并、身份字段完整的候选视为 eligible。唯一候选自动选择；多候选、身份冲突或证据缺失均 fail closed。`--pr` 只能从权威 closing eligible 集合中显式选择，不能绕过仓库、Issue、合并或身份校验。

## 授权与持久审计

当次调用只以 typed result 的 `mode=external`、`authorization` 和 `selected` 为机器分支依据。`pr_status: created` 只是现有 verifier 的兼容 shim，表示任务已绑定可验证的 PR；它既不表示 PR 由本任务创建，也不能单独授权跳过 lifecycle。

成功绑定会原子写入 PR 字段并追加 `Bind External PR` Activity Log，记录授权来源、Issue、PR URL/编号、base/head repository/ref/SHA、合并时间和 merge commit。相同完整证据重试为 no-op；已有同号但缺审计签名时补写一次；编号或身份变化失败。不得调用 PR create 路径。

外部模式仍须通过身份、required-PR、本地生命周期与终态校验；review ledger、manual validation、post-review commit 和平台同步等外围证据在 lifecycle 后作为 warning/pending steps 投影。无 canonical review-code 时仅沿用 verifier 已定义的 N/A 规则；`--force` 不解除身份、本地原子性或 required-PR 硬门禁。
