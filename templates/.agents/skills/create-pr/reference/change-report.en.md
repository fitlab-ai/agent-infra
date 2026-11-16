# PR Code Change Report

<!-- pr-change-report-contract
{"source":"platform-pr-inspect","diff":"three-dot-find-renames","metrics":["numstat-lines","git-blob-bytes"],"publish":["pr-summary","user-response"]}
-->

After a PR is created or uniquely reused, use the authoritative `base.sha` and `head.sha` returned by `platform-pr inspect` to measure the complete PR diff. Do not substitute the last commit or current worktree state. The complete PR keeps the existing three-dot, merge-base, patch, and sidecar identity. The task-intent digest covers only the semantic section from `# Task`/`# 任务` through `## Context`/`## 上下文`, so lifecycle logs, receipts, and version metadata do not stale a sidecar for the same head.

## Evidence Commands

```bash
node .agents/skills/create-pr/scripts/change-report.mjs --base {base-sha} --head {head-sha} --kind merge-base
node .agents/skills/create-pr/scripts/change-report.mjs --base {base-sha} --head {head-sha} --kind head-to-head --from-head {previous-head-sha}
git diff --find-renames --name-status {base-sha}...{head-sha}
git diff --find-renames --summary {base-sha}...{head-sha}
```

Pass the script JSON and the model-generated six-check precheck candidate to the typed core:

```bash
agent-infra-internal platform-pr change-report {task-id} \
  --agent {standard-agent-token} --mechanical-file {mechanical-report-file} \
  --precheck-file {precheck-candidate-file}
```

The core validates the task-intent digest, PR identity, complete patch SHA, totals, and the ordered checks `target-alignment`, `change-composition`, `compatibility-policy`, `legacy-path-cleanup`, `redundancy`, and `scope-discipline`. A `needs-review` check routes to `review-code`; `formalReview` remains `false`.

Put the `--kind merge-base` output under `full`. When a valid prior sidecar exists, put the `--kind head-to-head --from-head {previous-head}` output under `increment.diff`, and bind its `identity.head.sha`, current head, and raw sidecar SHA-256 as `fromHead`, `toHead`, and `sourceReportSha256`. Without a valid prior sidecar use `status=unconfirmed` with null source and diff. For the same head use `status=unchanged`, identical endpoints, no source hash, and `diff:null`. Core independently validates the source and recomputes the bundle; hand-entered mechanics or coordinates are rejected.

The mechanical-file uses schema v2 with PR `base/head`, a `full` comparison, and an `increment` status. `full` uses `kind=merge-base`. A confirmed increment includes `kind=head-to-head`, `fromHead/toHead`, and source sidecar SHA-256. Without a valid same-PR sidecar, use `status=unconfirmed` and `diff:null`; identical heads use `status=unchanged` and `diff:null`. Core verifies the prior sidecar before replacement and recomputes both scopes.

Before generating the candidate, list functional change groups from the task goal and both diffs. Represent each group in `change-composition.groups[]` with `id`, `target`, `behaviorChange`, `necessity`, `files[]`, `locations:{full:[],increment:[]}`, and `tests:{coverage,cost}`. Each location has canonical `path`, `side` (`new` for additions, `old` for deletions), `startLine`, and `endLine`. `rationale` and `Evidence[]` may support the judgment but cannot replace group objects.

- `files[]` references canonical paths (`oldPath ?? newPath`) from either scope. A mixed file may appear in multiple groups; a rename stays one record with both paths.
- `locations.full` and `locations.increment` must cover each changed line exactly once per scope, either in one group or under `unassigned` with `reason=shared|unconfirmed` and an explanation. Core rejects duplicates, gaps, wrong path/direction, and out-of-range coordinates, then derives counts and reconciles each scope with its own totals. Binary files have no locations and remain uncountable; do not invent zeroes or ranges.
- `Evidence[].detail` may cite relevant code, test, or documentation changes. Use `tests.coverage` and `tests.cost` for existing/new test coverage and fixture/test cost. If no test changed, state why existing coverage is sufficient.
- List and reconcile complete-PR changes separately from the current head-to-head increment. Do not infer increment values when the previous head is unconfirmed.

`target-alignment` passes only when every group maps to a task goal or acceptance criterion. Typed structure, file membership, and derived counts are structural checks; the existing semantic review still decides whether groups, behavior added/removed, necessity, test coverage/cost, and evidence are adequately explained. Missing, contradictory, or unverifiable structure or explanation remains `needs-review`; state the gap so the core routes to `review-code`. Complete structure or green CI does not establish sufficient explanation.

State the actual finding for each of the other four checks. Use the deployed skill's language for evidence; Chinese deployments must use Chinese. The canonical renderer displays every rationale and evidence item. Source line counts describe text additions/deletions only; they do not prove execution counts or workflow unification.

## Complete PR and Per-Round Increment

Complete-PR statistics always use the current authoritative snapshot's `base.sha...head.sha` and the existing three-dot mechanical report. The report may separately describe the increment from the last valid canonical sidecar's `identity.head.sha` to the current snapshot's `head.sha`. Before rebuilding the report, validate the prior sidecar with the existing `readPrChangeReport`; use its head only when repository/resource identity matches the current PR. Compare the two trees for the increment with `git diff --find-renames --numstat {previous-head} {current-head}`, `--name-status`, and `--summary`. Do not substitute a merge-base diff for these endpoints or add increment totals to complete-PR totals.

If there is no prior sidecar, it is invalid, or its PR identity differs, state that the previous head is unconfirmed. Do not infer per-round numbers from the complete PR or fabricate zeroes. If both SHAs are identical, state that the head did not change and omit extra statistics. After a rebase, compare the old and new head trees directly; this describes tree changes, not commit counts or execution counts. A missing/invalid prior sidecar does not block the complete-PR report.

The script calculates both `numstat` line counts and exact Git blob byte sizes between the merge base and head. Bytes provide a stable unit, cover binary files, and reveal same-line compaction; submodules are not blobs and contribute zero bytes. Added files have zero old bytes, deleted files have zero new bytes, pure renames have zero net bytes, and copies count only the new destination content.

Count binary files in the file total but do not invent line counts for `-` numstat values. Explain renames and copies from the script's per-file records, `name-status`, and `summary` so moves are not reported as full rewrites.

## Classification and Reconciliation

Using the repository's actual structure, assign every file to exactly one closest category and omit categories that do not apply:

- Runtime code
- Tests and test support
- Skills, workflows, and collaboration rules
- Templates or generated mirrors
- Documentation
- Configuration, dependencies, and other files

The canonical summary's fixed categories separate `docs/` and Markdown/MDX/reStructuredText documents from other files. More specific runtime-code, test, template, and `.agents/` categories take precedence; remaining paths go to Other.

The table must contain component, file count, added lines, deleted lines, net lines, old bytes, new bytes, and net bytes, followed by a total row. Byte columns describe the blob content size of files involved in this change, not disk usage for the entire repository or worktree. Use exact integers; optional KiB/MiB values may aid readability but must not replace byte counts.

Category line and byte totals must each reconcile exactly with the script's `totals`. Then, for text files only, list the largest files by line change and absolute net-byte change, distinguishing source, tests, and template mirrors. Keep binary files in the category totals only; do not rank or interpret their content. Show renames as path changes without inferring a "pure rename" label.

## Required Analysis

Briefly explain:

- where growth is concentrated and how runtime code compares with tests, docs, and templates;
- whether net line and net byte changes tell different stories, especially for substantial same-line compaction or expansion;
- which line changes are path moves, bilingual mirrors, or mechanical synchronization;
- whether any change cannot be traced directly to the PR goal and may be unnecessary; if none, state the evidence; every check must cite file and line evidence;
- when a test fixture is much larger than production changes, what risk it covers instead of judging it only by size.

Do not write the `### PR Code Changes` section in the caller. Put exactly one `<!-- canonical-pr-change-report -->` placeholder in the plain body and let `summary-sync --change-report-file <task-workspace>/active/{task-id}/pr-change-report.json --result {primary-result}` replace it through the core renderer. Do not create a second PR comment for this report.
