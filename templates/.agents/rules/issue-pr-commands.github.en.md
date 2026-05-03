# Issue / PR Platform Commands

Read this file before verifying platform authentication, reading Issues / PRs, or creating and updating Issues / PRs.

## Authentication and Repository Info

Verify that GitHub CLI is available and authenticated:

```bash
gh auth status
gh repo view --json nameWithOwner
```

If either command fails, stop or degrade according to the calling skill.

## Upstream Repository and Permission Detection

Before any later `gh issue` or `gh api "repos/..."` call, follow `.agents/rules/issue-sync.md` to resolve `upstream_repo`, `has_triage`, and `has_push`.

- every later `gh issue` command must use `-R "$upstream_repo"`
- every later repository-scoped `gh api` command must use `"repos/$upstream_repo/..."`
- keep `gh pr *` commands on the current repository without adding `-R`
- keep organization-scoped commands such as `gh api "orgs/{owner}/..."` unchanged

## Issue Template Detection

Detect GitHub Issue Forms with:

```bash
rg --files .github/ISSUE_TEMPLATE -g '*.yml' -g '!config.yml'
```

Read matching form files locally before creating the Issue. If the directory is missing or no form matches the task, use the caller's fallback body format.

Typical candidate templates:
- `bug_report.yml` for bug work
- `question.yml` for question or investigation work
- `feature_request.yml` for feature work
- `documentation.yml` for documentation work
- `other.yml` as the general fallback

For GitHub Issue Forms, inspect the matched form's:
- `name`
- `type:`
- `labels:`
- `body:`

Field handling rules:
- `textarea` and `input`: use `attributes.label` as the markdown heading and fill values from task.md
- `markdown`: skip template explanation prose
- `dropdown` and `checkboxes`: skip
- when task.md lacks a suitable value, write `N/A`

Suggested field mapping:

| Template field hint | task.md source |
|---|---|
| `summary`, `title` | task title |
| `description`, `problem`, `what happened`, `issue-description`, `current-content` | task description |
| `solution`, `requirements`, `steps`, `suggested-content`, `impact`, `context`, `alternatives`, `expected` | requirements list |
| other `textarea` / `input` fields | task description, otherwise `N/A` |

## Read and Create Issues

Read an Issue:

```bash
gh issue view {issue-number} -R "$upstream_repo" --json number,title,body,labels,state,milestone,url
```

Create an Issue:

```bash
gh issue create -R "$upstream_repo" --title "{title}" --body "{body}" --assignee @me {label-args} {milestone-arg}
```

- expand `{label-args}` into repeated `--label` flags from the validated label list
- pass `{label-args}` only when `has_triage=true`; otherwise omit it and continue
- omit all `--label` flags when nothing valid remains
- pass `{milestone-arg}` only when `has_triage=true`; otherwise omit it and continue
- omit `{milestone-arg}` entirely when no milestone should be set

Set the Issue Type:

```bash
gh api "orgs/{owner}/issue-types" --jq '.[].name'
gh api "repos/$upstream_repo/issues/{issue-number}" -X PATCH -f type="{issue-type}" --silent
```

- set the Issue Type only when `has_push=true`; otherwise skip and continue

## Update Issues

Use this shape when updating titles, labels, assignees, or milestones:

```bash
gh issue edit {issue-number} -R "$upstream_repo" {edit-args}
```

Common arguments:
- `--title "{title}"`
- `--add-label "{label}"` (only when `has_triage=true`)
- `--remove-label "{label}"` (only when `has_triage=true`)
- `--add-assignee @me`
- `--milestone "{milestone}"` (only when `has_triage=true`)

Do not pre-check assignee permissions. If the assignee command fails, silently skip it per the caller's contract.

Close an Issue:

```bash
gh issue close {issue-number} -R "$upstream_repo" --reason "{reason}"
```

## Read Issue Comments

Read Issue comments or search for existing hidden markers:

```bash
gh api "repos/$upstream_repo/issues/{issue-number}/comments" --paginate
```

## PR Template and Metadata Helpers

Read a repository PR template when present:

```bash
cat .github/PULL_REQUEST_TEMPLATE.md
```

Review recent merged PRs for style:

```bash
gh pr list --limit 3 --state merged --json number,title,body
```

Verify that standard type labels exist before PR metadata sync:

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

If the result is `0`, run `init-labels` before retrying PR metadata sync.

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
gh pr create --base "{target-branch}" --title "{title}" --assignee @me \
  {label-args} {milestone-arg} \
  --body "$(cat <<'EOF'
{pr-body}
EOF
)"
```

- expand `{label-args}` into repeated `--label "{label}"` flags from the validated label list
- pass `{label-args}` only when `has_triage=true`; otherwise omit it and continue
- omit all `--label` flags when nothing valid remains
- expand `{milestone-arg}` into `--milestone "{milestone}"`
- pass `{milestone-arg}` only when `has_triage=true`; otherwise omit it and continue
- omit `{milestone-arg}` entirely when no milestone should be set

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
- insufficient permission: skip direct writes according to the `has_triage` / `has_push` branch and continue
- `@me` is resolved by `gh` CLI to the authenticated user
