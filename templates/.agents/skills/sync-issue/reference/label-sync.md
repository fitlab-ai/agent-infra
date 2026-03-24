# Label and Issue Type Sync

Read this file before editing `status:`, `in:`, or Issue Type metadata.

### 6. Sync Labels and Issue Type

Initialize labels when needed:

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

If the result is `0`, run `init-labels` and retry this step.

Status label workflow:

```bash
gh issue view {issue-number} --json labels --jq '.labels[].name | select(startswith("status:"))'
gh issue edit {issue-number} --remove-label "{status-label}"
gh issue edit {issue-number} --add-label "{status-label}"
```

Status decision table:

| Condition | Action |
|---|---|
| task lives under `blocked/` | add `status: blocked` |
| Mode A: completed | add no new `status:` label |
| Mode B: PR is `MERGED` | add no new `status:` label |
| Mode B: PR is `OPEN` | add `status: in-progress` |
| Mode C + `current_step` ∈ {`requirement-analysis`, `technical-design`} | add `status: pending-design-work` |
| Mode C + `current_step` ∈ {`implementation`, `code-review`, `refinement`} | add `status: in-progress` |

`in:` label workflow:

```bash
gh label list --search "in: {module}" --limit 10 --json name --jq '.[].name'
gh issue edit {issue-number} --add-label "in: {module}"
```

`in:` label flow:
1. extract changed file paths from implementation artifacts first; fall back to analysis artifacts only when implementation artifacts do not exist
2. take the first path segment as `{module}`
3. de-duplicate all inferred modules
4. check whether each exact `in: {module}` label exists before adding it
5. add matching labels only; never remove existing `in:` labels

Issue Type workflow:

```bash
gh api "orgs/$owner/issue-types" --jq '.[].name'
gh api "repos/$repo/issues/{issue-number}" -X PATCH -f type="{name}"
```

Issue Type mapping:

| task.md type | GitHub Issue Type |
|---|---|
| `bug`, `bugfix` | `Bug` |
| `feature`, `enhancement` | `Feature` |
| `task`, `documentation`, `dependency-upgrade`, `chore`, `docs`, `refactor`, `refactoring`, and all other values | `Task` |

If Issue Types are unavailable, record `Issue Type: skipped (not enabled)` and continue.
