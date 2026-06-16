# PR Checks Platform Commands (GitHub)

Read this file before watching a PR's required checks, resolving a failing run, pulling failure logs, or reading the current branch's PR. The `watch-pr` skill's platform-specific commands live here; the skill body and `reference/` stay platform-agnostic.

## Current Branch PR / Repository Info

```bash
gh pr view --json number -q .number                  # PR number for the current branch
gh pr view {pr#} --json headRefOid -q .headRefOid    # PR head SHA
gh repo view --json nameWithOwner -q .nameWithOwner  # {owner}/{repo}
```

If `gh` is not authenticated or a command fails, stop or degrade per the calling skill's error handling.

## Watch Required Checks

```bash
gh pr checks {pr#} --required --watch --fail-fast -i 30 \
  --json name,bucket,link,workflow
```

- `--required`: include only checks the repository's branch protection marks as required.
- `--watch`: block until those checks finish; `--fail-fast`: exit watch on the first failure.
- `-i 30`: poll every 30 seconds (backoff). **Overall time cap default 30 minutes (1800 seconds)**: use the timeout mechanism that matches the execution environment; on timeout, treat as "pending" (exit code 8).
  - POSIX shell: `timeout 1800 gh pr checks {pr#} --required --watch --fail-fast -i 30 …`
  - PowerShell (Windows): use a job timeout —
    ```powershell
    $job = Start-Job { gh pr checks {pr#} --required --watch --fail-fast -i 30 }
    if (Wait-Job $job -Timeout 1800) { Receive-Job $job } else { Stop-Job $job; <treat as "pending"> }
    ```
  - Platform-neutral fallback (no external timeout tool): record the start time, loop `gh pr checks {pr#} --required --json name,bucket,link,workflow` **without** `--watch`, sleeping `-i` seconds each round and checking whether any `bucket` is still `pending`; if the elapsed time reaches 1800 seconds without finishing, exit the loop and treat as "pending".
- The `bucket` field of `--json` classifies each check as `pass` / `fail` / `pending` / `skipping` / `cancel`.

Exit code semantics:

| Exit code | Meaning | Outcome class |
|-----------|---------|---------------|
| 0 | all required checks passed | all green |
| 1 | at least one failed / errored | failure |
| 8 | still pending (watch timed out or was cut off by `timeout`) | pending |

Old `gh` (< 2.93) without `--required`: fall back to `gh pr checks {pr#} --watch --fail-fast` (i.e. "all checks must succeed"), and note this degradation in the help/report and suggest upgrading `gh`.

## Resolve a Failing Run id and Pull Logs

`gh pr checks --json` does not return a run id directly, but it returns each failing check's `link` (a URL to the run/job). Resolve in this deterministic order:

1. Extract from the failing check's `link` via regex: `https://github.com/{owner}/{repo}/actions/runs/(\d+)(?:/job/(\d+))?` → group 1 is the run id (optional group 2 is the job id).
2. When `link` is not a run URL or cannot be parsed, query check-runs by head SHA:
   ```bash
   sha=$(gh pr view {pr#} --json headRefOid -q .headRefOid)
   gh api "repos/{owner}/{repo}/commits/$sha/check-runs" \
     --jq '.check_runs[] | select(.name=="{failed-check-name}") | .details_url'
   ```
   then extract the run id from `details_url` the same way.
3. If neither path yields a run id → treat as "unlocatable" and use the skill's help exit; do not self-heal blindly.

Once the run id is known, pull the failure logs:

```bash
gh run view {run-id} --log-failed
```
