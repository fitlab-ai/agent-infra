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
- **Same-round fix-and-close**: only when the reviewer fixes a `minor` finding during the current review round may `finding-review` move that row directly from `open` to `closed`. This transition does not increment `round`, and `evidence` must point to the fix in the current review artifact; it does not apply to `blocker` or `major` findings.
- **Severity is independent from advancement**: `blocker` / `major` / `minor` express impact only. Every formal finding blocks approval until terminal. After all writes, review verdicts, event counts, and next steps must be derived from `task-ledger stage-status --stage {stage}`.
- **Non-blocking advisories**: only future optimizations that do not affect the current artifact's completeness, correctness, or acceptance. Advisories stay in a separate report section and never enter this ledger, finding counts, or verdict; manual-validation remains a separate category.
- **Write responsibility**: callers submit structured intents only; they do not scan ids, assemble table rows, or decide mechanical transitions. `review-*` uses `agent-infra-internal task-ledger {task-id} finding-upsert|finding-review ...`; `*-task` uses `finding-respond ...`; `ai decide` applies human rulings atomically. The core validates and commits each intent through one task write.
- **Backward compatible**: when task.md has no such section the gate treats it as no open disagreements and passes.

### Executor-raised human-ruling rows

When an executor judges an item to be a key design decision that needs human ruling, it must write a self-contained detail block per `.agents/rules/human-decision-context.md` into the artifact's `## 人工裁决待办` (Pending Human Decisions) section with a heading like `### HD-N：<title> [needs-human-decision]`, and upsert the matching `HD-` row in task.md `## Review Disagreement Ledger`:

```markdown
| HD-1 | plan | - | decision | needs-human-decision | plan.md#HD-1 |
```

- `id`: the `HD-N` number is **globally unique**. First run `agent-infra-internal task-ledger {task-id} decision-next-id` and read `entityId`; after writing the stable artifact heading, run `decision-upsert --id {HD-N} --stage {stage} --artifact {artifact}`. The model must not scan or allocate ids.
- `stage` is the stage where the decision arose: `analysis` / `plan` / `code`.
- `round` is `-` because this is not a review-finding handshake round.
- `severity` is always `decision`.
- `status` starts as `needs-human-decision`, so the existing gate blocks it.
- `evidence` points to the stable anchor `<artifact>#HD-N` (e.g. `plan-r2.md#HD-1`), not a drift-prone line number.
- A human records the ruling with `ai decide <task-ref> <ordinal|ledger-id> <decision>`; the command flips the target row to `human-decided` and points `evidence` to an independent `HDR-N` ruling record.

> Viewing, deciding, and typed verification share the `lib/task/ledger.ts` domain semantics; no second parser is maintained.

## post-review commit gate (code stage only)

- `review-code` captures the reviewed commit `R` (this round's HEAD) and an independent diff base `D` exactly once. `F` covers the complete difference from D to the current worktree, while normalized snapshot tree `T` represents the current worktree. An Approved snapshot with `T == R^{tree}` may set `B=R`; an Approved snapshot with uncommitted changes clears or omits `B`.
- `commit` reads only the highest-round Approved `review-code` artifact. Before committing it requires `pre_head == R`, complete worktree tree `W == T`, and normalized staged tree `S == T`; any mismatch blocks before `git commit` and reports added, missing, and different paths for both comparisons.
- After a successful commit it sets `B=last_reviewed_commit=<new_head>`; B means only a reviewed snapshot anchored to a Git commit.
- The `complete-task` `post-review-commit` gate uses only B. When B is absent, malformed, or missing as a Git object, it reports `reviewed snapshot was not anchored` and never falls back to R.
- If new commits touch code / rule paths after B, the gate blocks and requires a fresh `review-code`. Automatic exceptions are limited to: (1) a bound platform change request (PR/MR) is merged and its platform adapter supplies an authoritative snapshot plus remote Git evidence refs; the gate fetches the reviewed head and target branch into an isolated temporary repository and proves B is the original change-request head, its merge commit is in authoritative target history, its reviewed changes exactly match the normalized patch of a single-parent squash commit, and its protected paths have no later commits; or (2) no valid change request, exactly one protected-path commit after B, that commit is a single-parent local rewrite in HEAD history, it has the same full tree or protected content as B, and no protected-path commits follow it. An unsupported adapter capability, missing required platform / Git evidence, or Git credentials that cannot read those remote refs fails closed.
- Required checks remain a pre-merge responsibility of branch protection / rulesets and the `review-code` / `watch-pr` routes. The post-review-commit gate still applies the applicable strict, PR-squash, or local-rewrite equivalence independently.
- **Exemption**: the canonical row is `| PRC-1 | post-review-commit | - | - | human-decided | <ruling note> |`. The id must be `PRC-N`, round and severity must be `-`, status must be `human-decided`, and evidence must be non-empty single-line text that records the ruling reason and applicable commit scope. Any malformed post-review row fails closed.
- A merged-PR human exemption may override only the stable `PR_MERGE_IDENTITY_INVALID` failure. Blocked results, missing evidence, content/topology/target-history mismatches, and all other failed codes must not consume PRC. The passing result must preserve the original failure code/message and every consumed PRC id/evidence, and must not describe the result as automatic equivalence.
- task.md is the persistent source of truth. Before preflight, the platform summary mirrors an existing warning or, without one, states only that the ruling awaits verification. After the exemption gate passes, the caller uses the gate output to complete the original-failure evidence and updates the same summary marker in place. The summary also mirrors the ruling reason, commit scope, human identity, and time from task.md.

## Gate behavior cheat sheet

| Caller | `review-ledger` scope | `post-review-commit` |
|--------|-----------------------|----------------------|
| `plan-task` | only `analysis`-stage rows must be terminal | not attached |
| `code-task` | `analysis` + `plan`-stage rows must be terminal | not attached |
| `complete-task` | all stage rows must be terminal | attached (see above) |
| `analyze-task` | not attached (first stage) | not attached |
