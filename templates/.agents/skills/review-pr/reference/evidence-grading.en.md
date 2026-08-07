# Evidence Grading Reference

This file fixes the evidence-graded decision flow of `review-pr`. All determinations are executed mechanically by the typed-core pure functions (`lib/pr-review/evidence-grading.ts`); the skill's prompt layer only orchestrates. This file explains the criteria and rationale; it does not replace the core.

## Main Decision Flow

```text
Resolve PR base/head and linked Issue/task (host resolution)
   ├─ Unique host → bind the task, enumerate artifact presence → evidence classification
   ├─ Ambiguous hosts → fail closed (decide refuses to classify; require a human-pinned host)
   └─ No host → block by default and require linking; explicit one-shot → reviews/{pr-number}/
        ↓
Evidence scenario classification (S1/S2/S3) → freshness/alignment → risk grading → mode selection
```

## Host Resolution

- Exactly one hit → `unique`; multiple without a unique winner → `ambiguous` (candidate list); zero hits → `none`.
- Ambiguous hosts fail closed and never enter evidence classification. `pr-review-grade resolve-host --pr <N>` returns a typed `HostResolution`, and `decide` explicitly rejects `ambiguous`.
- `Closes/Fixes #N` in the PR body (case-insensitive, comma/space separated, lists supported) is parsed by `extractClosingIssueNumbers`; a local `active/*/task.md` `pr_number` hit takes priority over the `issue_number` reverse lookup, and a task hit via both paths deduplicates to a single candidate.

## Evidence Scenario Classification (S1 → S2 → S3)

| Scenario | Criteria |
|----------|----------|
| S1 complete & trusted | unique task with matching issue_number + complete `analysis`/`plan`/`code` and all three review families + latest `pr-review*` reviewed head == current head + trusted source |
| S2 partial / suspect | task exists but key artifacts are missing, or the head drifted, or the source is untrusted / cannot prove alignment with the current head |
| S3 PR-only | no host; or unique task with no lifecycle artifacts at all and no prior `pr-review*` |

- S3(b) symmetric criterion: `!hasAnalysis && !hasPlan && !hasCode && !hasReviewAnalysis && !hasReviewPlan && !hasReviewCode && !hasPriorPrReview`. A malformed task with only one review family (review-analysis / review-plan / review-code) falls to S2 → audit.
- On first review (no prior `pr-review*`) S1(c) is unsatisfied, so a complete-lifecycle task falls to S2 → audit.

## Freshness and Alignment

- Freshness benchmark = the reviewed head SHA recorded by the latest `pr-review*`, compared character-for-character with the current head: match → `fresh`, otherwise → `stale`.
- Alignment = freshness is `fresh` and the `issue_number` / `pr_number` match the resolution result.
- No prior `pr-review*` → `n/a` / `n/a` (first-review special case).

## Risk Grading (pure evidence)

| Factor | LOW | HIGH |
|--------|-----|------|
| Change size | few files, small net additions | many files, large net additions |
| Change sensitivity | no protected paths touched | touches lifecycle / rule / skill / config / security / auth / idempotency / concurrency paths |
| Structural change | no schema/frontmatter/migration/interface-contract changes | involves schema / frontmatter / migration / interface contract |
| Test coverage | tests present and passing | no tests or tests missing/failing |
| Source credibility | a reviewable trusted lifecycle exists and aligns with the current head | no trusted record, or the source is not reviewable |
| Recovery/merge impact | recovery contract unaffected | may break the recovery contract or create a dual-write source |

Aggregation: any priority factor (sensitivity / source credibility) HIGH → HIGH; otherwise any HIGH → MEDIUM; all LOW → LOW. Identity factors never participate in any factor determination.

## Mode Selection Matrix

| Evidence scenario | Freshness/alignment | Risk | Mode |
|-------------------|---------------------|------|------|
| S1 | fresh + aligned | LOW/MEDIUM | verify (lightweight recheck) |
| S1 | fresh + aligned | HIGH | audit (evidence audit) |
| S2 | stale / misaligned / partial-missing | any | audit |
| S3 | n/a | any | reconstruct (reconstruction review) |

Running `review-pr` on a complete-lifecycle task for the first time falls to S2 → audit because there is no prior head record; "trusted lifecycle records → verify" corresponds to the re-review case where a prior `pr-review*` exists and the head has not drifted.

## Minimum-Sufficient Reconstruction

When the mode is `reconstruct` (or `audit` with insufficient evidence), form a reconstruction record before the line-level review covering at least: requirement boundary, architecture choices, impact surface, validation coverage; the on-disk order is "Reconstruction Context → Coverage Matrix → line-level Findings".
