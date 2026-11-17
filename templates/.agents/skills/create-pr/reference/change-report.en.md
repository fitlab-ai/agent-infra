# PR Code Change Report

<!-- pr-change-report-contract
{"source":"platform-pr-inspect","diff":"three-dot-find-renames","metrics":["numstat-lines","git-blob-bytes"],"publish":["pr-summary","user-response"]}
-->

After a PR is created or reused, use the authoritative `base.sha` and `head.sha` returned by `platform-pr inspect` to measure the complete PR diff. Do not substitute the last commit or current worktree state. The scope is the target branch merge-base through the current PR HEAD. The task-intent digest covers only the semantic section from `# Task`/`# 任务` through `## Context`/`## 上下文`.

## Evidence Commands

```bash
node .agents/skills/create-pr/scripts/change-report.mjs --base {base-sha} --head {head-sha}
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

The script output is the mechanical bundle's `full` diff. The bundle uses schema v3 and the persisted canonical report uses schema v5; both carry only the complete PR merge-base→HEAD comparison. Core validates the task-intent digest, PR identity, full patch SHA, totals, and the six prechecks in fixed order. Any `needs-review` item routes to `review-code`; `formalReview` remains `false`.

Before generating the candidate, list functional change groups from the task goal and complete PR diff; file descriptions or category totals cannot stand in for functional groups. Represent each group in `change-composition.groups[]` with `id`, `target`, `behaviorChange`, `necessity`, `files[]`, `locations:{full:[]}`, and `tests:{coverage,cost}`. `rationale` and `Evidence[]` may support the judgment and locations but cannot replace group objects. Each location has canonical `path`, `side` (`new` for additions, `old` for deletions), `startLine`, and `endLine`.

- `files[]` may reference only canonical paths in the complete PR diff (`oldPath ?? newPath`); a mixed file may appear in multiple groups. A rename remains one mechanical record with both paths.
- `locations.full` must cover each changed line exactly once, either in one group or under `unassigned:{full:[]}` with `reason=shared|unconfirmed` and an explanation. Core rejects duplicates, gaps, wrong path/direction, and out-of-range coordinates, then derives group and unassigned additions/deletions from positions and reconciles them with complete PR totals. Candidates must not submit group counts.
- Binary files with `numstat=null` have no locations; keep them in file and category totals, mark their line counts as unknown, and do not invent zeroes or ranges.
- Each `Evidence[].detail` may cite specific code, tests, or documentation. `tests.coverage` and `tests.cost` describe coverage risk/evidence and the cost of any new fixture or test. When no tests change, state the existing coverage basis.

`target-alignment` passes only when every group maps to a task goal or acceptance criterion. Typed structure, file membership, and derived counts are structural checks; the existing semantic review still decides whether groups, behavior added/removed, necessity, test coverage/cost, and evidence are adequately explained. Missing, contradictory, or unverifiable structure or explanation remains `needs-review`; state the gap so the core routes to `review-code`. Complete structure or green CI does not establish sufficient explanation.

State the actual finding for each of the other four checks. Use the deployed skill's language for evidence; Chinese deployments must use Chinese. The canonical renderer displays every rationale and evidence item. Source line counts describe text additions/deletions only; they do not prove execution counts or workflow unification.

## Complete PR Scope

Complete PR statistics use the current authoritative snapshot's `base.sha...head.sha` and the three-dot mechanical report. The functional module numbers table immediately follows the category statistics table; detailed behavior, necessity, files, and test notes follow both. The renderer generates canonical content from the core-validated structured report.

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
