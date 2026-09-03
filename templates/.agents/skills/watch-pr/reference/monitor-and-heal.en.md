# Monitoring & Self-Heal Details

Platform-agnostic decision logic for `watch-pr` steps 2/3/4. The concrete platform commands (watch, resolve a failing run, pull logs, read the PR number) live in `.agents/rules/pr-checks-commands.md`; this file only describes platform-independent classification and decisions.

## Readiness Classification

After the watch command, route by structured `readiness.state`:

- `ready`: all checks passed and the same head is explicitly mergeable → SKILL step 7.
- `checks-failed`: a check failed or was cancelled → CI healing in SKILL step 3.
- `conflicting`: the platform explicitly reports a head/base conflict → rebase healing in SKILL step 3.
- `pending|timed-out|cancelled`: no reliable success fact exists → SKILL step 4.

## Summary Refresh Boundary

Before readiness in every round, and after an external push, self-heal commit, or successful rebase changes the PR head, rerun `summary-context` → mechanical report and six-check precheck → `platform-pr change-report` → `summary-sync --change-report-file ... --result no_op` with exactly one `<!-- canonical-pr-change-report -->` placeholder. The core revalidates the sidecar against the authoritative PR snapshot, task-intent digest, and complete patch; missing, stale, invalid, bypassed, or raced publication must not continue to a ready/complete route and must enter the help exit with a warning.

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
PR #{pr#} monitoring is blocked; manual intervention needed.

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
