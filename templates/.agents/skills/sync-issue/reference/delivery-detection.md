# Delivery Detection

Read this file before deciding whether the task is completed, in PR stage, or still in development.

## Detect Delivery Status

Resolve repository coordinates first:

```bash
repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
owner="${repo%%/*}"
repo_url="https://github.com/$repo"
```

Delivery checks:
- extract the last commit hash from `**Commit** by` in Activity Log
- inspect protected branches with `git branch -a --contains {commit-hash} 2>/dev/null`
- inspect PR state with `gh pr view {pr-number} --json state,mergedAt`

Protected branch matching rules:
- output contains `main` or `master` -> treat as protected mainline
- output matches `{major}.{minor}.x` -> treat as a protected release line
- otherwise -> not on a protected branch

Scenario decision matrix:

| Condition | Scenario |
|---|---|
| commit is already on a protected branch | Scenario A: Completed |
| PR exists and its state is `OPEN` or `MERGED` | Scenario B: PR stage |
| all other cases | Scenario C: In development |

Scenario priority:
- Scenario A: Completed
- Scenario B: PR stage
- Scenario C: In development

Priority rule: `Scenario A > Scenario B > Scenario C`. Even if a PR exists, once the commit is on `main`, `master`, or `{major}.{minor}.x`, report the task as completed.

Absolute links must use:
- `https://github.com/{owner}/{repo}/commit/{commit-hash}`
- `https://github.com/{owner}/{repo}/pull/{pr-number}`
