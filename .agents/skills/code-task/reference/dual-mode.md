# code-task 三模式判定

本文件说明核心 artifact lifecycle 的 code 模式判定。`task-artifact` 命令是单点真相；修改核心判定时必须同步更新本文档。

## 输入

```bash
agent-infra-internal task-artifact {task-id} inspect --family code
```

核心读取最新 analysis 的路径裁定，并选择生命周期输入：精简路径使用 analysis，标准或完整路径使用 plan；完整路径还校验对应 review-plan。随后扫描 code 与 review-code 产物。

`code.started` 会在 task.md frontmatter 中绑定本轮生命周期输入及其 SHA-256。`code.completed` 使用该开始上下文并校验当前最新输入；内容变化失败关闭。实现报告的“生命周期输入”仅供读者追溯，不参与生命周期身份校验。

## 8 个分支

> 分支按表中自上而下的顺序评估，命中即返回；后续分支不再判定。

| 条件 | mode | exit | 行为 |
|---|---|---:|---|
| 无 code 产物，且所选生命周期输入有效；完整路径的最新 review-plan 还必须精确为 `Approved` 并引用最新 plan | `init` | 0 | 初次实现，产物为 `code.md` |
| 最新 analysis 或 plan 生命周期输入未被最新 code 完成 receipt 绑定 | `init` | 0 | 输入在上轮 code 后发生有效变化，进入新一轮实现；缺失或无效 receipt 失败关闭 |
| 最新 review-code 的完成收据未绑定最新 code identity/SHA | `error` | 2 | 最新代码未审查，先运行 `review-code`；code 与 review-code 的 family 轮次可独立增长 |
| 最新 review-code 为 Approved 且存在审查完成后产生的 pending 实现输入 | `decision` | 0 | 选择最早 `II-N`，进入裁决驱动实现；false/not-required 与 consumed 输入不触发 |
| 最新 review-code 为 Approved 且 0/0/0 | `refused` | 1 | 已通过，无需再次运行 `code-task` |
| 最新 review-code 为 Approved 但有 major/minor | `fix` | 0 | 可选修复模式 |
| 最新 review-code 为 Changes Requested | `fix` | 0 | 必需修复模式 |
| 最新 review-code 为 Rejected | `refused` | 1 | 需要重新设计，不进入局部修复 |

> 上表 5 个 review-code 分支在 `rev_max >= code_max` 时命中，均以最新 `review-code-r{rev_max}` 的结论及实现输入决定：
> - `rev_max == code_max`：AI 修复轮（`code-task` 产出代码后由 `review-code` 审查同号产物）。
> - `rev_max > code_max`：人工补审轮——PR 创建后维护者追加一轮 `review-code-r{N}` 审查既有最新代码。此时 `fix` 模式的 `next_round = code_max + 1`。
>
> 若最新 `review-code` 的 verdict 无法解析，仍返回 `error`（exit 2），作为保留的异常拦截。

## verdict 解析

脚本支持中文和英文 review-code 报告：

| 语义 | 中文 | 英文 |
|---|---|---|
| 摘要段落 | `## 审查摘要` | `## Review Summary` |
| 总体结论字段 | `**总体结论**：` | `**Overall Verdict**:` |
| 发现统计字段 | `**发现（AI 可处理）**：` | `**Findings (AI-actionable)**:` |

结论映射：

- `通过` / `Approved` -> `Approved`，再按 blocker/major/minor 计数拆成 `Approved` 或 `Approved-with-issues`
- `需要修改` / `Changes Requested` -> `Changes Requested`
- `拒绝` / `Rejected` -> `Rejected`

manual-validation 计数不参与 mode 判定。

## 输出契约

脚本输出 JSON：

```json
{
  "mode": "init",
  "code_max": 0,
  "rev_max": 0,
  "verdict": null,
  "next_round": 1,
  "next_artifact": "code.md",
  "review_artifact": null,
  "implementation_input": null,
  "decision_id": null,
  "decision_evidence": null,
  "message": "..."
}
```

`review_artifact` 字段在第 2 分支（replan-driven init）下指向触发的 `review-plan-r{N}.md` 而非 review-code 产物，用于追溯触发原因。

exit code：

- `0`：可继续，`mode` 为 `init`、`fix` 或 `decision`
- `1`：拒绝继续，`mode` 为 `refused`
- `2`：状态异常，`mode` 为 `error`
