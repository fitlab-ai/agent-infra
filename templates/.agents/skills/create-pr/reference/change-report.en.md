# PR Code Change Report

<!-- pr-change-report-contract
{"version":1,"source":"platform-pr-inspect","diff":"three-dot-find-renames-numstat","publish":["pr-summary","user-response"]}
-->

After a PR is created or uniquely reused, use the authoritative `base.sha` and `head.sha` returned by `platform-pr inspect` to measure the complete PR diff. Do not substitute the last commit or current worktree state.

## Evidence Commands

```bash
git diff --find-renames --numstat {base-sha}...{head-sha}
git diff --find-renames --name-status {base-sha}...{head-sha}
git diff --find-renames --summary {base-sha}...{head-sha}
```

Count binary files in the file total but do not invent line counts for `-` numstat values. Explain renames and copies from `name-status` and `summary` separately so moves are not reported as full rewrites.

## Classification and Reconciliation

Using the repository's actual structure, assign every file to exactly one closest category and omit categories that do not apply:

- Runtime code
- Tests and test support
- Skills, workflows, and collaboration rules
- Templates or generated mirrors
- Documentation
- Configuration, dependencies, and other files

The table must contain component, file count, additions, deletions, and net change, followed by a total row. Category totals must reconcile exactly with the complete numstat total. Then list the largest changed files and distinguish source, tests, template mirrors, and pure renames.

## Required Analysis

Briefly explain:

- where growth is concentrated and how runtime code compares with tests, docs, and templates;
- which line changes are path moves, bilingual mirrors, or mechanical synchronization;
- whether any change cannot be traced directly to the PR goal and may be unnecessary; if none, state the evidence;
- when a test fixture is much larger than production changes, what risk it covers instead of judging it only by size.

Add the complete report as a `### PR Code Changes` section in the reviewer summary body. Preserve the same table and conclusion in the user-visible create-pr completion response. Do not create a second PR comment for this report.
