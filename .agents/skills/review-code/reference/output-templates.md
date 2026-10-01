# 审查输出模板

在向用户汇报最终审查结论之前先读取本文件。

> 本文件描述的是「向用户汇报结论」的 3 个结果场景（A/B/C）。场景 R 只用于生命周期未完成时展示已有结果，不属于审查结论分类。产物的 `**总体结论**：` 字段仍只取 3 个规范值（`通过` / `需要修改` / `拒绝`，或 EN 对应 `Approved` / `Changes Requested` / `Rejected`）。

## 选择唯一输出场景

按 `stage-status` 结果判断（**注意：manual-validation 和 advisory 数量不参与判断**）：
1. 如果 `stageStatus.canAdvance=true`，使用场景 A
2. 如果结论为需要修改且 findings 可局部修复，使用场景 B（不按 blocker 数量拆分）
3. 如果任务需要重大重构、大范围重写或整体重来，使用场景 C

禁止规则：
- 不要跳过场景判断步骤
- 不要混用不同场景的文案
- 只要 `Blocker > 0`，就绝对不能输出通过模板
- manual-validation 项绝对不能被计入 blocker / major / minor 计数，也不能用作触发场景 B/C 的依据
- 所选场景必须通过统一 helper 生成 `{next-step-commands}`
- 计数行固定显示 5 个数字。manual-validation（`{e}`）不影响分支；`人工裁决`（`{h}`）是本阶段 `needs-human-decision` 行数，属于未闭环账本状态，因此 `{h} > 0` 时 `canAdvance=false`，必须按 `.agents/rules/next-step-output.md` 的「人工裁决待办前置块」展开详情，并只输出修订与复审路径。

### 场景 R：最终化停止但结果可见

当 finalizer 失败，或模型因安全门、无进展、重复诊断或紧急熔断停止时，使用本场景，不调用统一 helper，也不输出跨阶段命令。

```text
任务 {task-id} 审查结果已生成，但生命周期未推进。
- 审查产物：.agents/workspace/active/{task-id}/{review-artifact}
- 最后有效 summary/findings：{last-readable-review-result}
- 本地修复次数：{repairAttempts}
- 最后诊断：{last-structured-diagnostic}
- 停止原因：{stop-reason}
- 完成事件：未发布 | 跨阶段命令：未生成

说明：本次仅停止生命周期推进，已有审查结果仍可查看。请先进行人工处理，或重新运行当前审查技能。
```

如果 summary 无法安全解析，`{last-readable-review-result}` 必须改为“摘要不可安全解析”，并保留 artifact 路径和原始结构化诊断；不得推算计数或补写结论。

### 场景 A：通过且无问题

通过后不得按轮次路由。读取任务的 `prFlow` / verified `pr_delivery_fact`；存在 PR 时调用 `agent-infra-internal platform-checks inspect {task-id}`。只选择以下一个互斥出口：

- 无 PR：`prFlow=disabled` 用场景 A4（完成）；PR flow 开启时用场景 A1（创建 PR）。
- 已有 PR 但 PR head != `R`：场景 A2（更新已有 PR）。
- PR head = `R`，checks 为 `pending|failed|cancelled` 或平台暂不可用：场景 A3（监控），不得输出完成命令。
- PR head = `R`，checks 为 `passed|no-required`：场景 A4（完成）。

场景 A 的共同摘要：

```text
任务 {task-id} 代码审查完成。结论：通过。
- 阻塞项：0 | 主要问题：0 | 次要问题：0 | 人工校验点：{e} | 人工裁决：{h}
[- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}]

```

#### 场景 A1：创建 Pull Request

使用 `agent-infra-internal agent-client next-steps --skill create-pr --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

```text
下一步 - 创建 Pull Request：
{next-step-commands}
```

#### 场景 A2：更新已有 Pull Request

使用 `agent-infra-internal agent-client next-steps --skill commit --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。`commit` 会交付当前提交；没有新提交时执行 push-only，将更新推送到已绑定的 PR。完成后按 commit 技能的绑定 PR 路由进入 `watch-pr`。

```text
下一步 - 更新已有 Pull Request：
{next-step-commands}
```

#### 场景 A3：监控全部 checks

使用 `agent-infra-internal agent-client next-steps --skill watch-pr --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

```text
下一步 - 监控 PR 检查：
{next-step-commands}
```

#### 场景 A4：完成并归档

使用 `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

```text
下一步 - 完成并归档任务：
{next-step-commands}
```

### 场景 B：需要局部修订

无论 findings 中是否包含 blocker，只要可以局部修复或按需修复，都使用同一个场景。阻塞项、主要问题和次要问题分别填写实际未解决计数。若 `h > 0`，遵循 `.agents/rules/next-step-output.md` 展开裁决待办；裁决完成后用 `review-code` helper 重新检视，不输出 `code-task` 命令。若 `h = 0`，使用 `code-task` helper 修复 findings。

`h = 0` 时运行 `agent-infra-internal agent-client next-steps --skill code-task --task-ref {task-ref}` 生成 `{next-step-commands}`：

```text
任务 {task-id} 代码审查完成。结论：需要修改。
- 阻塞项：{blockers} | 主要问题：{major} | 次要问题：{minor} | 人工校验点：{e} | 人工裁决：{h}
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 修复问题：
{next-step-commands}

```

`h > 0` 时运行 `agent-infra-internal agent-client next-steps --skill review-code --task-ref {task-ref}` 生成裁决完成后的 `{next-step-commands}`；在命令前展示规则要求的人工裁决待办块。

### 场景 C：拒绝并重新设计

使用 `agent-infra-internal agent-client next-steps --skill plan-task --task-ref {task-ref}` 生成本场景的 `{next-step-commands}`。

```text
任务 {task-id} 代码审查完成。结论：拒绝，需要重新设计方案。
- 阻塞项：{blockers} | 主要问题：{major} | 次要问题：{minor} | 人工校验点：{e} | 人工裁决：{h}
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 重新设计技术方案：
{next-step-commands}

> 注意：Rejected 表示实现方向需要整体重做，不是局部修复。核心 artifact lifecycle 的分支 #7 会拒绝直接 `/code-task`，要求先重新方案设计。

```

## 人工校验提醒

场景 A/B/C 的输出中，如果 `{e} > 0`，在所选场景内容之后附加以下提醒；场景 R 不使用此提醒：

```text
提醒：manual-validation 项需在 PR description 的「待人工验证」清单中承接，不应触发 /code-task。
```
