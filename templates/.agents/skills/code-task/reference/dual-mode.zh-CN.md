# code-task 双模式判定

本文件说明 `scripts/detect-mode.js` 的行为。脚本是单点真相；修改脚本时必须同步更新本文档。

## 输入

```bash
node .agents/skills/code-task/scripts/detect-mode.js .agents/workspace/active/{task-id}
```

脚本扫描任务目录中的 `code.md` / `code-r{N}.md` 和 `review-code.md` / `review-code-r{N}.md`。

## 7 个分支

| 条件 | mode | exit | 行为 |
|---|---|---:|---|
| 无 code 产物 | `init` | 0 | 初次实现，产物为 `code.md` |
| `rev_max < code_max` | `error` | 2 | 最新代码未审查，先运行 `review-code` |
| `rev_max > code_max` | `error` | 2 | 数据状态异常，需要人工检查 |
| 最新 review-code 为 Approved 且 0/0/0 | `refused` | 1 | 已通过，无需再次运行 `code-task` |
| 最新 review-code 为 Approved 但有 major/minor | `fix` | 0 | 可选修复模式 |
| 最新 review-code 为 Changes Requested | `fix` | 0 | 必需修复模式 |
| 最新 review-code 为 Rejected | `refused` | 1 | 需要重新设计，不进入局部修复 |

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

env-blocked 计数不参与 mode 判定。

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

exit code：

- `0`：可继续，`mode` 为 `init` 或 `fix`
- `1`：拒绝继续，`mode` 为 `refused`
- `2`：状态异常，`mode` 为 `error`
