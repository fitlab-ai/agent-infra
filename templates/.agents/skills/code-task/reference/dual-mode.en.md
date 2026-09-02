# code-task three-mode decision

This file documents the core artifact lifecycle's code-mode decision. The `task-artifact` command is the source of truth; update this document whenever the core decision changes.

## Input

```bash
agent-infra-internal task-artifact {task-id} inspect --family code
```

The core scans `plan.md` / `plan-r{N}.md`, `review-plan.md` / `review-plan-r{N}.md`, `code.md` / `code-r{N}.md`, and `review-code.md` / `review-code-r{N}.md` in the task directory.

`code.started` persists the plan identity and SHA-256 for the round in task.md frontmatter. `code.completed` must read the canonical plan from the implementation report's `Plan Input` field and match both that start context and the current latest plan; missing, mismatched, or changed input fails closed.

## Eight Branches

> Branches are evaluated top-down in this table; the first match returns and skips later rows.

| Condition | mode | exit | Behavior |
|---|---|---:|---|
| no code artifact, and the latest review-plan is exactly `Approved` and references the latest plan | `init` | 0 | initial implementation, output `code.md`; a missing matching approval or `Approved-with-issues` returns an error |
| latest review-plan is exactly `Approved`, references the latest plan, and the latest code completion receipt does not bind the same plan digest | `init` | 0 | enter a new implementation round. `Approved-with-issues` remains parse-compatible for history but is not cross-stage approval; missing or invalid receipts fail closed |
| `rev_max < code_max` | `error` | 2 | latest code round is unreviewed; run `review-code` first |
| latest review-code is Approved and a pending implementation input was decided after that review completed | `decision` | 0 | select the earliest `II-N` and enter decision-driven implementation; false/not-required and consumed inputs do not trigger |
| latest review-code is Approved with 0/0/0 | `refused` | 1 | already approved; do not run `code-task` again |
| latest review-code is Approved with major/minor findings | `fix` | 0 | optional fix mode |
| latest review-code is Changes Requested | `fix` | 0 | required fix mode |
| latest review-code is Rejected | `refused` | 1 | re-plan instead of local fixing |

> The five review-code branches above fire when `rev_max >= code_max`, decided by the latest `review-code-r{rev_max}` verdict and implementation inputs:
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

manual-validation counts do not affect mode selection.

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
  "implementation_input": null,
  "decision_id": null,
  "decision_evidence": null,
  "message": "..."
}
```

In the replan-driven init branch (row #2), `review_artifact` points to the `review-plan-r{N}.md` that triggered replan rather than a review-code artifact, preserving the attribution chain.

exit code:

- `0`: continue, `mode` is `init`, `fix`, or `decision`
- `1`: stop, `mode` is `refused`
- `2`: inconsistent state, `mode` is `error`
