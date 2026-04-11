# Issue / PR Platform Commands

Read this file before verifying platform authentication, reading Issues / PRs, or creating and updating Issues / PRs.

## Authentication and Repository Info

Verify that GitHub CLI is available and authenticated:

```bash
gh auth status
gh repo view --json nameWithOwner
```

If either command fails, stop or degrade according to the calling skill.

## Read and Create Issues

Read an Issue:

```bash
gh issue view {issue-number} --json number,title,body,labels,state,milestone,url
```

Create an Issue:

```bash
gh issue create --title "{title}" --body "{body}" --assignee @me {label-args} {milestone-arg}
```

- expand `{label-args}` into repeated `--label` flags from the validated label list
- omit all `--label` flags when nothing valid remains
- omit `{milestone-arg}` entirely when no milestone should be set

Set the Issue Type:

```bash
gh api "orgs/{owner}/issue-types" --jq '.[].name'
gh api "repos/{owner}/{repo}/issues/{issue-number}" -X PATCH -f type="{issue-type}" --silent
```

## Update Issues

Use this shape when updating titles, labels, assignees, or milestones:

```bash
gh issue edit {issue-number} {edit-args}
```

Common arguments:
- `--title "{title}"`
- `--add-label "{label}"`
- `--remove-label "{label}"`
- `--add-assignee @me`
- `--milestone "{milestone}"`

Close an Issue:

```bash
gh issue close {issue-number} --reason "{reason}"
```

## Read Issue Comments

Read Issue comments or search for existing hidden markers:

```bash
gh api "repos/{owner}/{repo}/issues/{issue-number}/comments" --paginate
```

## Read and Create PRs

Read a PR:

```bash
gh pr view {pr-number} --json number,title,body,labels,state,milestone,url,files
```

List PRs:

```bash
gh pr list --state {state} --base {base-branch} --json number,title,url,headRefName,baseRefName
```

Create a PR:

```bash
gh pr create --base "{target-branch}" --title "{title}" --assignee @me --body "$(cat <<'EOF'
{pr-body}
EOF
)"
```

## Update PRs

Update PR titles, labels, or milestones with:

```bash
gh pr edit {pr-number} {edit-args}
```

Common arguments:
- `--title "{title}"`
- `--add-label "{label}"`
- `--remove-label "{label}"`
- `--milestone "{milestone}"`

## Error Handling

- read failures: stop or skip based on the calling skill
- update failures: warn and continue when the caller marks the action as best-effort
- `@me` is resolved by `gh` CLI to the authenticated user
