# code-task 双模式判定

本文件说明 `scripts/detect-mode.js` 的行为。脚本是单点真相；修改脚本时必须同步更新本文档。

## 输入

```bash
node .agents/skills/code-task/scripts/detect-mode.js .agents/workspace/active/{task-id}
```

脚本扫描任务目录中的 `plan.md` / `plan-r{N}.md`、`review-plan.md` / `review-plan-r{N}.md`、`code.md` / `code-r{N}.md` 和 `review-code.md` / `review-code-r{N}.md`。

## 7 个分支

> 分支按表中自上而下的顺序评估，命中即返回；后续分支不再判定。

| 条件 | mode | exit | 行为 |
|---|---|---:|---|
| 无 code 产物 | `init` | 0 | 初次实现，产物为 `code.md` |
| 最新 review-plan 已批准（`通过` 或 `通过 + major/minor 建议`，即 `Approved` 或 `Approved-with-issues`），且其「审查输入」/「Review Input」字段引用的 plan 文件 == 任务目录中最新的 `plan(-r{N})?.md`，且最新 review-plan 的 mtime > 最新 code 的 mtime | `init` | 0 | plan 已在 code 之后被批准；进入新一轮实现，`next_round = code_max + 1`、`next_artifact = code-r{next_round}.md`。**不论 review-code 是否已审**，本分支均先命中。plan 与 review-plan 的轮次独立递增（如 `plan-r5` 可被 `review-plan-r4` 批准），通过 review-plan 的「审查输入」字段建立批准关系，不要求同号 |
| `rev_max < code_max` | `error` | 2 | 最新代码未审查，先运行 `review-code` |
| 最新 review-code 为 Approved 且 0/0/0 | `refused` | 1 | 已通过，无需再次运行 `code-task` |
| 最新 review-code 为 Approved 但有 major/minor | `fix` | 0 | 可选修复模式 |
| 最新 review-code 为 Changes Requested | `fix` | 0 | 必需修复模式 |
| 最新 review-code 为 Rejected | `refused` | 1 | 需要重新设计，不进入局部修复 |

> 上表 4 个 verdict 分支在 `rev_max >= code_max` 时命中，均以最新 `review-code-r{rev_max}` 的结论决定：
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
  "message": "..."
}
```

`review_artifact` 字段在第 2 分支（replan-driven init）下指向触发的 `review-plan-r{N}.md` 而非 review-code 产物，用于追溯触发原因。

exit code：

- `0`：可继续，`mode` 为 `init` 或 `fix`
- `1`：拒绝继续，`mode` 为 `refused`
- `2`：状态异常，`mode` 为 `error`
