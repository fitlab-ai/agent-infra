# code-task dual mode

This file documents `scripts/detect-mode.js`. The script is the source of truth; update this document whenever the script changes.

## Input

```bash
node .agents/skills/code-task/scripts/detect-mode.js .agents/workspace/active/{task-id}
```

The script scans `plan.md` / `plan-r{N}.md`, `review-plan.md` / `review-plan-r{N}.md`, `code.md` / `code-r{N}.md`, and `review-code.md` / `review-code-r{N}.md` in the task directory.

## Seven Branches

> Branches are evaluated top-down in this table; the first match returns and skips later rows.

| Condition | mode | exit | Behavior |
|---|---|---:|---|
| no code artifact | `init` | 0 | initial implementation, output `code.md` |
| latest review-plan is approved (`Approved` or `Approved-with-issues`, i.e. `Overall Verdict: Approved` regardless of findings counts), its "Review Input" / "审查输入" entry names the same plan file as the latest `plan(-r{N})?.md` in the task directory, and its mtime is newer than the latest code artifact | `init` | 0 | plan has been approved after the latest code; enter a new implementation round, `next_round = code_max + 1`, `next_artifact = code-r{next_round}.md`. This branch fires regardless of whether review-code exists or passes. Plan and review-plan rounds are independent counters (e.g. `plan-r5` may be approved by `review-plan-r4`); the link is established via the review-plan's "Review Input" entry, not by matching round numbers. |
| `rev_max < code_max` | `error` | 2 | latest code round is unreviewed; run `review-code` first |
| latest review-code is Approved with 0/0/0 | `refused` | 1 | already approved; do not run `code-task` again |
| latest review-code is Approved with major/minor findings | `fix` | 0 | optional fix mode |
| latest review-code is Changes Requested | `fix` | 0 | required fix mode |
| latest review-code is Rejected | `refused` | 1 | re-plan instead of local fixing |

> The four verdict branches above fire when `rev_max >= code_max`, decided by the latest `review-code-r{rev_max}` verdict:
> - `rev_max == code_max`: AI fix round (`review-code` reviews the same-numbered code artifact produced by `code-task`).
> - `rev_max > code_max`: human-supplemented review round — after a PR is opened a maintainer appends a `review-code-r{N}` round against the existing latest code. `fix` mode then uses `next_round = code_max + 1`.
>
> If the latest `review-code` verdict cannot be parsed, the script still returns `error` (exit 2) as the retained anomaly guard.

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

In the replan-driven init branch (row #2), `review_artifact` points to the `review-plan-r{N}.md` that triggered replan rather than a review-code artifact, preserving the attribution chain.

exit code:

- `0`: continue, `mode` is `init` or `fix`
- `1`: stop, `mode` is `refused`
- `2`: inconsistent state, `mode` is `error`
