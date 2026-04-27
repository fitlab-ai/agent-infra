# Label / Milestone Platform Commands

Read this file before initializing labels, initializing milestones, or adjusting milestones during release work.

## Authentication and Repository Info

```bash
gh auth token
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

## Label Operations

List existing labels:

```bash
gh label list --limit 200 --json name --jq '.[].name'
```

Create or update a label:

```bash
gh label create "{name}" --color "{color}" --description "{description}" --force
```

## Milestone Operations

List milestones:

```bash
gh api "repos/$repo/milestones?state=all" --paginate
```

Create a milestone:

```bash
gh api "repos/$repo/milestones" -f title="{title}" -f description="{description}" -f state="{state}"
```

Update a milestone:

```bash
gh api "repos/$repo/milestones/{number}" -X PATCH -f state="{state}" -f description="{description}"
```

## Error Prompt Templates

Use these normalized prompts when the GitHub setup scripts fail:

| Condition | Prompt |
|---|---|
| CLI missing | GitHub CLI (`gh`) is not installed |
| Authentication failed | `GitHub CLI is not authenticated` |
| API rate limit | `GitHub API rate limit reached, please retry later` |

## Constraints

- use label names as the idempotency key
- use milestone titles as the idempotency key, then milestone numbers when patching state
- stop or skip according to the calling skill when commands fail
