# 通用规则 - 模型驱动的本地产物恢复

本规则适用于 `analyze-task`、`plan-task`、`code-task` 的本地产物完成前门禁，以及三个 review skill 的 summary finalizer。它只处理当前 task 目录内的一个 canonical artifact；不适用于 `task.md`、账本、receipt、源码、Git、平台资源或生命周期状态。

## 完成前门禁

- 完成事件前必须运行对应 finalizer；只有同一次返回的 `artifactSha256` 和 `semanticDigest` 才能传给 completed event。
- preflight 先对当前 stable-read candidate 完整验证，并将验证的 `R` 写入 digest-addressed、只读的 generation；在 journal CAS 前正式 artifact 必须保持 baseline `B`。
- candidate SHA 是 awaiting 状态的最后一次 stable-read 观测值，不是下一次编辑的 guard。合法 `S` 编辑必须重新验证并在成功后 CAS 为 `R`。
- 只有在机械安全门通过后，模型才可编辑返回的 `candidatePath`；每次实际字节变化后，用同一 task、stage/family、artifact 和 `--recovery-id` 完整重跑 finalizer。不得直接编辑正式 artifact 后假设它属于候选。
- preflight 按 `preflight-ready → preflight-commit-started → preflight-passed` 发布 immutable `R`；业务 finalizer 再按 `full-finalizer-ready → commit-started → passed` 将 `F` 发布。`F=R` 复用 active generation。
- preflight-ready 后 publish 只读取 active/pending generation，绝不再读取可编辑 candidate。
- candidate-only 是协议授权边界，不是操作系统隔离：拥有同一 UID 且可任意写入宿主文件系统的进程可能篡改 recovery 内部文件；协议会通过身份、指纹和状态校验发现异常并失败关闭，但不承诺独立权限主体或跨平台隔离。

## 授权边界

- finalizer 和 recovery core 只校验身份、状态、权限、稳定读取、完整 artifact 语义和指纹；不根据错误码猜测“可修复”，也不提供文本操作白名单。
- 模型只能修改当前 skill 声明的一个普通 artifact。不得修改 task.md、账本、receipt、源码、其他报告或远端资源。
- `changed=false`、错误码和格式形状只是诊断事实，不是编辑授权。人工裁决、并发、权限、I/O、身份、provenance 或未知状态无法证明安全时，立即停止。

## 不可绕过的机械安全门

每次编辑候选前确认：

1. finalizer 返回失败并提供同一 recovery context，且没有正式提交；
2. task、family/stage、round、artifact、request/authority 和 baseline 指纹仍匹配；
3. `candidatePath` 是 recovery core 生成的受控普通文件，formal target 没有外部变化；
4. 修改不改变人工裁决语义、详情或账本身份，也不引入其他副作用。

任一条件不满足，停止，不编辑、不发布 completed。

## Durable recovery 状态

| 状态 | formal artifact | 允许动作 |
| --- | --- | --- |
| `awaiting-preflight-recovery` | baseline `B` | 只编辑 candidate `S`，稳定读取、验证并生成 `R` |
| `preflight-ready` / `preflight-commit-started` | `B` 或 `R` | 只可从 active immutable `R` reconcile/publish |
| `preflight-passed` | `R` | 执行业务 finalizer，生成或复用 `F` |
| `full-finalizer-ready` / `commit-started` | `R` 或 `F` | 只可从 pending immutable `F` reconcile/publish |
| `passed` | `F` | completed event 校验 final digest 后消费 |
| `consumed` | `F` | 可由中间产物清理流程回收受控 staging/backup |
| `aborted` | 已确认恢复的 `B` | 只保留诊断，不得伪造成功 |

intent 使用 current-only schema version 4。旧 schema 直接失败关闭；不添加迁移、adapter 或双写。candidate、baseline、generation 和 intent 位于 repo-local 受控目录，使用 canonical recovery ID、普通文件检查、stable read、task lock 和 expected-value CAS。跨文件不宣称原子性；未知组合返回 indeterminate 并保留现场。

## 动态收敛循环

1. 用固定 invocation 运行 finalizer。
2. 每次失败且安全门通过时，读取结构化诊断和 `candidatePath`，仅作一次最小、可解释的候选编辑。
3. 确认字节变化后，使用同一 `--recovery-id` 完整重跑全部 finalizer 校验；仍失败但诊断和指纹均未重复时，回到第 2 步。
4. 诊断或指纹重复、无字节进展、恢复状态未知、无法安全修复或达到当前 invocation 的 8 次编辑上限时停止；不发布 completed，不生成跨阶段 next-step。

## 共享入口

`task-artifact ... inspect|init|preflight|finalize-local` 和 `task-review ... finalize-summary` 是当前入口。preflight 不发布 task metadata、ledger、formal provenance、completed event 或平台状态；恢复重试使用 finalizer 返回的 `recoveryId`，例如：

```text
agent-infra-internal task-artifact {task-id} finalize-local --family code --artifact {code-artifact} --recovery-id {recovery-id}
agent-infra-internal task-review {task-id} finalize-summary --stage code --artifact {review-artifact} --recovery-id {recovery-id}
```

不再存在 `task-artifact repair`、`replace-line`、`insert-section` 或 `repairable` 授权。结构引擎只返回诊断和 digest；候选是否安全、如何修改以及何时停止由当前 skill 的机械门和模型逐例判断。

## 生命周期隔离

completed event 合法地修改 task.md，但必须发生在 finalizer recovery 已 `passed` 且 digest、round、request/authority 全部匹配之后。若 event 写入后 authority 消费失败，保留正式 artifact，使用既有 lifecycle recovery compensation；不得重放 completed 写入或回滚已通过的 artifact。
