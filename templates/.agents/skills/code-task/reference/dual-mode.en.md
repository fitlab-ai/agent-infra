# code-task dual mode

This file documents `scripts/detect-mode.js`. The script is the source of truth; update this document whenever the script changes.

## Input

```bash
node .agents/skills/code-task/scripts/detect-mode.js .agents/workspace/active/{task-id}
```

The script scans `code.md` / `code-r{N}.md` and `review-code.md` / `review-code-r{N}.md` in the task directory.

## Seven Branches

| Condition | mode | exit | Behavior |
|---|---|---:|---|
| no code artifact | `init` | 0 | initial implementation, output `code.md` |
| `rev_max < code_max` | `error` | 2 | latest code round is unreviewed; run `review-code` first |
| `rev_max > code_max` | `error` | 2 | inconsistent state; manual inspection required |
| latest review-code is Approved with 0/0/0 | `refused` | 1 | already approved; do not run `code-task` again |
| latest review-code is Approved with major/minor findings | `fix` | 0 | optional fix mode |
| latest review-code is Changes Requested | `fix` | 0 | required fix mode |
| latest review-code is Rejected | `refused` | 1 | re-plan instead of local fixing |

## Verdict Parsing

The script supports zh-CN and English review-code reports:

| Meaning | zh-CN | English |
|---|---|---|
| summary section | `## 审查摘要` | `## Review Summary` |
| verdict field | `**总体结论**：` | `**Overall Verdict**:` |
| findings field | `**发现（AI 可处理）**：` | `**Findings (AI-actionable)**:` |

Verdict mapping:

- `通过` / `Approved` -> `Approved`, then blocker/major/minor counts split it into `Approved` or `Approved-with-issues`
- `需要修改` / `Changes Requested` -> `Changes Requested`
- `拒绝` / `Rejected` -> `Rejected`

env-blocked counts do not affect mode selection.

## Output Contract

The script prints JSON:

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

exit code:

- `0`: continue, `mode` is `init` or `fix`
- `1`: stop, `mode` is `refused`
- `2`: inconsistent state, `mode` is `error`
