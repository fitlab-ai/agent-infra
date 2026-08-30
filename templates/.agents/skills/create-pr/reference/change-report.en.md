# PR Code Change Report

<!-- pr-change-report-contract
{"source":"platform-pr-inspect","diff":"three-dot-find-renames","metrics":["numstat-lines","git-blob-bytes"],"publish":["pr-summary","user-response"]}
-->

After a PR is created or uniquely reused, use the authoritative `base.sha` and `head.sha` returned by `platform-pr inspect` to measure the complete PR diff. Do not substitute the last commit or current worktree state.

## Evidence Commands

```bash
node .agents/skills/create-pr/scripts/change-report.mjs --base {base-sha} --head {head-sha}
git diff --find-renames --name-status {base-sha}...{head-sha}
git diff --find-renames --summary {base-sha}...{head-sha}
```

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

The table must contain component, file count, added lines, deleted lines, net lines, old bytes, new bytes, and net bytes, followed by a total row. Byte columns describe the blob content size of files involved in this change, not disk usage for the entire repository or worktree. Use exact integers; optional KiB/MiB values may aid readability but must not replace byte counts.

Category line and byte totals must each reconcile exactly with the script's `totals`. Then list the largest files by line change and absolute net-byte change, distinguishing source, tests, template mirrors, and pure renames.

## Required Analysis

Briefly explain:

- where growth is concentrated and how runtime code compares with tests, docs, and templates;
- whether net line and net byte changes tell different stories, especially for substantial same-line compaction or expansion;
- which line changes are path moves, bilingual mirrors, or mechanical synchronization;
- whether any change cannot be traced directly to the PR goal and may be unnecessary; if none, state the evidence;
- when a test fixture is much larger than production changes, what risk it covers instead of judging it only by size.

Add the complete report as a `### PR Code Changes` section in the reviewer summary body. Preserve the same table and conclusion in the user-visible create-pr completion response. Do not create a second PR comment for this report.
