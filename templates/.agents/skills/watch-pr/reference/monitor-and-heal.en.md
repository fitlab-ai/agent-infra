# Monitoring & Self-Heal Details

Platform-agnostic decision logic for `watch-pr` steps 2/3/4. The concrete platform commands (watch, resolve a failing run, pull logs, read the PR number) live in `.agents/rules/pr-checks-commands.md`; this file only describes platform-independent classification and decisions.

## Readiness Classification

After the watch command, route by structured `readiness.state`:

- `ready`: all checks passed and the same head is explicitly mergeable → SKILL step 7.
- `checks-failed`: a check failed or was cancelled → CI healing in SKILL step 3.
- `conflicting`: the platform explicitly reports a head/base conflict → rebase healing in SKILL step 3.
- `pending|timed-out|cancelled`: no reliable success fact exists → SKILL step 4.

## Summary Refresh Boundary

Before readiness in every round, and after an external push, self-heal commit, or successful rebase changes the PR head, rerun `summary-context` → mechanical report and six-check precheck → `platform-pr change-report` → update the full PR summary JSON per `.agents/rules/pr-sync.md` → `summary-sync --change-report-file ... --result no_op --strict`. `--strict` preserves report or summary refresh failures as `failed/blocked`. The core revalidates the sidecar and reads back the remote body; missing, stale, invalid, incomplete, or raced publication must not continue to a ready/complete route.

When rebuilding the precheck, each of the six `rationale` fields must state its actual finding and include at least one item of evidence with a path, line range, and concise `detail`; state compatibility, legacy-path, redundancy, and scope findings separately without generic boilerplate. Use the deployed skill's language for rationales and evidence; Chinese deployments must use Chinese.

Use the candidate content contract in `.agents/skills/create-pr/reference/change-report.md` for functional grouping, per-group fields, unique line attribution, and `needs-review` criteria. Rebuild groups from the current task goal and patch on every refresh; do not reuse prior-head explanations as evidence for the current increment. Reconcile complete-PR statistics separately from the previous valid head → current head increment; explicitly mark the increment unconfirmed when no previous head can be verified. If any group lacks goal alignment, behavior added/removed, necessity, line-count reconciliation, test coverage/cost, or locatable evidence, mark `target-alignment` or `change-composition` as `needs-review` and identify the gap. Reuse the existing `nextAction=review-code` route; structural completeness or green CI must not continue to `watch-pr`.

Keep complete-PR scope bound to the current authoritative base/head/merge-base/patch and its full statistics. Report the increment separately as previous valid report head → current head. Before overwriting the prior sidecar, validate it with `readPrChangeReport`; use its `identity.head.sha` only when its repository/resource identity matches the current PR. Compare the two head trees directly and state both SHAs. Do not substitute a merge-base diff for these endpoints or add increment totals to complete-PR totals. If no prior report exists, it is invalid, or its identity differs, mark the previous head unconfirmed; do not infer values from the full PR or fill in zeroes. Identical SHAs mean the head did not change. After a rebase, compare the old and new head trees. An invalid sidecar makes only the increment unconfirmed; the existing full-PR report flow continues.

## Precheck Route

After `summary-sync --strict` succeeds, consume its structured `nextAction` result before entering readiness:

- `nextAction=review-code`: stop this Watch PR readiness/self-heal loop, recommend `review-code` through the unified helper, and end the round. Green CI does not clear necessity concerns, and Watch PR must not perform automatic redundancy cleanup or refactoring.
- `nextAction=watch-pr`: continue through the existing readiness classification and self-heal decision tree.
- Missing or invalid `nextAction`: use the strict-refresh help exit; do not infer `watch-pr`.

This route reuses the result already derived by the core from the six checks. It does not grant Watch PR authority to write a `review-code` report or perform automatic fixes.

## Self-Heal Decision Tree

```text
# self-heal-test-command-contract
primary: failing-job-command
fallback-source: project-test-skill
unknown: help
```

For each failing check, decide "self-heal" vs "ask for help" in this order:

1. **Can the corresponding CI run be located** (per the rule's "Resolve a failing run id")? No → ask for help.
2. **Which layer is the failure?**
   - Code layer (self-healable): lint / format / type check / unit or integration test assertions / build-compile errors — locatable to a specific file and cause in this repo from the logs.
   - Non-code layer (not self-healable): network flakiness, permissions / tokens, external service outages, dependency-source failures, obvious flakiness (a re-run might go green but it was not introduced by this change) → ask for help.
3. **Has the fix cap been reached** (default 2 push-fixes)? Yes → ask for help.
4. When "locatable + code layer + under cap" holds, perform one self-heal:
   - Before fixing, run `git status -s` to record the working tree and ensure only changes related to this failure are included.
   - Locate and make a minimal fix per the logs (touch only code / tests / config related to that failure).
   - Run the relevant tests: prefer the local command for the failing job; otherwise read the project `test` skill and select its declared core or full validation command. If neither command is known, ask for help. **Do not commit or push before tests pass.**
   - After tests pass, put the paths, message, expected HEAD, expected tree, and push policy (remote, full refs, automatic) into one intent JSON; call `git-workflow commit` once and verify the remote SHA. If the remote push fails, retry the same commit intent with empty `paths` through the push-only path.
   - Append the fix commit SHA to this run's `repairCommits`, increment the fix count, and return to SKILL step 2. When checks turn green, an empty list routes to `complete-task`; a non-empty list routes to `review-code`.
   - Never make unrelated "drive-by" optimizations; never loosen / skip the failing assertion to "make it green".

## Merge-Conflict Healing

```text
# conflict-heal-contract
strategy: rebase
remote-update: exact-lease
unsafe: help
```

1. Continue only when the PR, head, and base repositories match; the current branch equals the head ref; local HEAD equals the snapshot head SHA; and the worktree/index are clean.
2. Select a remote that exactly matches the PR repository, fetch the base ref, record the full `expectedBaseHead`, and confirm the remote head still equals the full old SHA.
3. Run `git rebase <expectedBaseHead>`. Handle only Git-reported text unmerged paths. If resolution is unsafe, run `git rebase --abort`, record paths and both SHAs, and use help.
4. After rebase, run the project `test` skill's full validation. Never push a failing result.
5. Write remote, branch, full `expectedOldHead`, `newHead`, baseBranch, and full `expectedBaseHead` to a temporary intent outside the repository; call `agent-infra-internal git-workflow push-rebased --input {intent.json}`.
6. Core verifies clean state, branch/HEAD, remote head/base, ancestry, exact `--force-with-lease`, and the post-push SHA. Never fall back to generic force; refresh the PR snapshot or use help.
7. On success, append the new SHA to `repairCommits`, increment `rebaseAttempts`, and watch the new head. Cap at two attempts; a final ready state with repairs routes only to `review-code`.

## Help Report Template

When entering the help exit, output the following fixed structure to the user (not written to any artifact file):

```
PR #{pr#} monitoring is blocked; use the evidence below to determine the required recovery action.

Blocker: {non-code layer / cap reached / run unlocatable / readiness unknown / unsafe rebase or update}
PR head/base: {repository/ref/SHA}
Conflict and remote facts: {paths / expected and actual head/base / rebase abort state}
Validation: {command and failure summary, or why it did not run}
Failing check: {name} (workflow: {workflow})
Failing run / logs: {run/job link}
Fixes attempted ({k} total):
  - {commit summary}: {change summary} → still failing after re-watch
Suggestion: {upgrade platform CLI / check permissions / re-run external dependency / inspect logs manually, etc.}
```
