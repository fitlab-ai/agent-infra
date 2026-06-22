# Bidirectional Review Handshake Protocol

> Shared by executor and reviewer across all three stages (analysis / plan / code) when running the `review-*` and `*-task` skills.
> This file is the **single source of truth** for the protocol; each SKILL only `Read`s it and never re-copies the vocabulary.

## Core principles

- **A review finding is input to be verified, not a command to execute.** The executor must verify each finding before disposing of it — neither rubber-stamping nor blindly refuting.
- **Symmetric evidence burden**: every disposition, whether accept or refute, must carry **commensurate evidence**. "Accept" is not a zero-cost default path.
- **Converge before advancing**: while any unclosed disagreement, alternative fix, cannot-judge, or post-review commit exists, do not silently advance to the next stage, archive, or merge.

## Executor four-state disposition (`*-task` skills, when responding to the prior review round in Round ≥ 2)

For each finding in the latest `review-*`, first Read/Grep the cited `file:line` / command, then assign one status:

| Status | Meaning | Required evidence |
|--------|---------|-------------------|
| `accepted` | Valid; will fix as suggested | `file:line` of the fix, or the change to be applied this round |
| `adjusted` | Valid, but an alternative fix is used | the alternative + why it is better; awaits reviewer confirmation |
| `refuted` | After verification, judged invalid / hallucinated / based on a wrong `file:line` | counter-evidence (`file:line` or raw command output); awaits reviewer confirmation |
| `cannot-judge` | Insufficient evidence to decide | the verification path attempted; handed to reviewer/human |

## Reviewer hand-back duty (`review-*` skills, when re-reviewing the executor response)

After the executor gives `adjusted` / `refuted` / `cannot-judge`, the reviewer must respond per item — never re-reading the original finding nor ignoring the hand-back:

- **Withdraw the finding** → set the ledger row to `confirmed` (accepts the refutation).
- **Accept the alternative fix** → set to `confirmed`.
- **Hold with new evidence** → set back to `open` (with new evidence, returned to the executor).
- **Escalate to human** → set to `needs-human-decision`.

## Convergence termination (loop guard)

- The per-finding handshake round limit is `MAX_HANDSHAKE_ROUNDS`, default **3**, overridable via `review.maxHandshakeRounds` in `.agents/.airc.json`.
- When a finding's `round` reaches the limit without entering a terminal state, it must be forced to `needs-human-decision`; the gate rejects rows that hit the limit without escalating.
- `needs-human-decision` keeps blocking completion until a human records a ruling in the task.md `## 人工裁决` section and flips the row to `human-decided`.

## Same-model convergence-bias mitigation (documentation-level discipline)

The executor and reviewer are often the same/similar model and are naturally inclined to agree. When reviewing:

1. **Read the evidence before the conclusion**: read the `git diff` / artifact itself and form findings independently **before** reading the executor's conclusions and responses, to avoid being anchored.
2. **Default-skeptical framing**: treat "looks fine" as unverified; every clearance needs reproducible evidence (see the `Evidence` hard gate in each `review-*`).

> The only mechanical lever is the **symmetric-evidence gate** (non-`open` ledger rows must carry evidence); model homogeneity itself is not mechanically checkable, so this section is discipline rather than a gate.

## Mechanical ledger (task.md `## 审查分歧账本`)

The single source of truth for disagreement state is the fixed `## 审查分歧账本` section in task.md — one parseable Markdown table. The phase-advance and `complete-task` gates read this section.

```markdown
## 审查分歧账本

<!-- One row per review finding; state machine / evidence rules in .agents/rules/review-handshake.md. The phase-advance and complete-task gates read this section. -->

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|
| CD-1 | code | 1 | blocker | open | review-code.md#1 |
```

- `id`: stage prefix + ordinal — analysis→`AN-`, plan→`PL-`, code→`CD-`; executor-raised human-ruling rows use `HD-`.
- `stage` ∈ `{analysis, plan, code}` (plus the reserved value `post-review-commit`, used only for post-review exemption rows).
- `status` legal enum: `open` / `accepted` / `adjusted` / `refuted` / `cannot-judge` / `confirmed` / `needs-human-decision` / `closed` / `human-decided`.
- **Terminal set (gate passes)**: `{confirmed, closed, human-decided}`; everything else is blocking.
- **Write responsibility**: `review-*` raises a finding → upsert an `open` row; `*-task` responds → set four-state and fill `evidence`, `round` +1; next `review-*` → `confirmed` / back to `open` / `needs-human-decision`; an executor fix verified by the next review → `closed`; a human ruling → `human-decided`.
- **Backward compatible**: when task.md has no such section the gate treats it as no open disagreements and passes.

### Executor-raised human-ruling rows

When an executor marks an item in the artifact `## Open Questions` section as `[needs-human-decision]`, it must upsert the matching `HD-` row in task.md `## Review Disagreement Ledger`:

```markdown
| HD-1 | plan | - | decision | needs-human-decision | plan.md#HD-1 |
```

- `stage` is the stage where the decision arose: `analysis` / `plan` / `code`.
- `round` is `-` because this is not a review-finding handshake round.
- `severity` is always `decision`.
- `status` starts as `needs-human-decision`, so the existing gate blocks it.
- After a human records the ruling in task.md `## Human Rulings`, flip the matching `HD-` row to `human-decided` and point `evidence` to that ruling.

## post-review commit gate (code stage only)

- The highest-round `review-code` report records `Review Baseline Commit` (R, `git rev-parse HEAD`) and `Reviewed Diff Fingerprint` (F, full worktree diff fingerprint).
- `commit` reads only the highest-round `review-code` artifact. When that artifact is Approved, the pre-commit HEAD equals R, and the staged diff fingerprint equals F, task.md receives `last_reviewed_commit` (B, the new commit SHA).
- The `complete-task` `post-review-commit` gate prefers B; when B is absent or invalid, it falls back to R from the highest-round `review-code` artifact.
- If new commits touch code / rule paths after B / R, the gate blocks and requires a fresh `review-code`.
- **Exemption**: append a ledger row `| PRC-1 | post-review-commit | - | - | human-decided | <ruling note> |` recording that a human explicitly allowed those commits without re-review.

## Gate behavior cheat sheet

| Caller | `review-ledger` scope | `post-review-commit` |
|--------|-----------------------|----------------------|
| `plan-task` | only `analysis`-stage rows must be terminal | not attached |
| `code-task` | `analysis` + `plan`-stage rows must be terminal | not attached |
| `complete-task` | all stage rows must be terminal | attached (see above) |
| `analyze-task` | not attached (first stage) | not attached |
