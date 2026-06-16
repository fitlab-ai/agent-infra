# Monitoring & Self-Heal Details

Platform-agnostic decision logic for `watch-pr` steps 2/3/4. The concrete platform commands (watch, resolve a failing run, pull logs, read the PR number) live in `.agents/rules/pr-checks-commands.md`; this file only describes platform-independent classification and decisions.

## Outcome Classification

After running the watch command from `.agents/rules/pr-checks-commands.md`, classify by its exit code into three buckets:

- All required checks passed → "all green" (SKILL step 7 green exit).
- At least one failed / errored → "failure" (SKILL step 3 self-heal).
- Still pending or the overall time cap was reached → "pending" (SKILL step 4 help exit).

## Self-Heal Decision Tree

For each failing check, decide "self-heal" vs "ask for help" in this order:

1. **Can the corresponding CI run be located** (per the rule's "Resolve a failing run id")? No → ask for help.
2. **Which layer is the failure?**
   - Code layer (self-healable): lint / format / type check / unit or integration test assertions / build-compile errors — locatable to a specific file and cause in this repo from the logs.
   - Non-code layer (not self-healable): network flakiness, permissions / tokens, external service outages, dependency-source failures, obvious flakiness (a re-run might go green but it was not introduced by this change) → ask for help.
3. **Has the fix cap been reached** (default 2 push-fixes)? Yes → ask for help.
4. When "locatable + code layer + under cap" holds, perform one self-heal:
   - Before fixing, run `git status -s` to record the working tree and ensure only changes related to this failure are included.
   - Locate and make a minimal fix per the logs (touch only code / tests / config related to that failure).
   - Run the relevant tests: prefer the local command for the failing job; fall back to `npm run test:core` repo-wide. **Do not commit or push before tests pass.**
   - After tests pass, publish the fix: per `.agents/rules/commit-and-pr.md` stage only the related files (`git add <paths>`, avoid `git add -A` pulling in unrelated changes) → create the fix commit (`git commit`) → `git push` to the current PR branch.
   - Record the fix commit SHA, increment the fix count, and return to SKILL step 2 to re-watch.
   - Never make unrelated "drive-by" optimizations; never loosen / skip the failing assertion to "make it green".

## Help Report Template

When entering the help exit, output the following fixed structure to the user (not written to any artifact file):

```
PR #{pr#} monitoring is blocked; manual intervention needed.

Blocker: {non-code layer / fix cap reached / run unlocatable / poll timeout}
Failing check: {name} (workflow: {workflow})
Failing run / logs: {run/job link}
Fixes attempted ({k} total):
  - {commit summary}: {change summary} → still failing after re-watch
Suggestion: {upgrade platform CLI / check permissions / re-run external dependency / inspect logs manually, etc.}
```
