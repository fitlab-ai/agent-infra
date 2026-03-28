# Labels, Issue Type, and Milestone Rules

Read this file before applying labels, Issue Type, milestone, or `in:` labels.

## Default Body Format (Fallback)

Recommended fallback:

```markdown
## Description

{task-description}

## Requirements

- [ ] {requirement-1}
- [ ] {requirement-2}
```

Map task types to GitHub labels and Issue Types, but keep only labels that actually exist.

Fallback label mapping:

| task.md type | GitHub label |
|---|---|
| `bug`, `bugfix` | `type: bug` |
| `feature` | `type: feature` |
| `enhancement` | `type: enhancement` |
| `docs`, `documentation` | `type: documentation` |
| `dependency-upgrade` | `type: dependency-upgrade` |
| `task`, `chore`, `refactor`, `refactoring` | `type: task` |
| other values | skip |

Issue Type fallback mapping:

| task.md type | GitHub Issue Type |
|---|---|
| `bug`, `bugfix` | `Bug` |
| `feature`, `enhancement` | `Feature` |
| `task`, `documentation`, `dependency-upgrade`, `chore`, `docs`, `refactor`, `refactoring`, and all other values | `Task` |

## Create the Issue

Use:

```bash
gh issue create --title "{title}" --body "{body}" --label "{label-1}" --label "{label-2}" --milestone "{milestone}"
```

If no valid labels remain, omit `--label`. If `milestone` is empty, fall back to `General Backlog`.

Issue Type setup:

```bash
gh api "orgs/$owner/issue-types" --jq '.[].name'
gh api "repos/$repo/issues/{issue-number}" -X PATCH -f type="{issue-type}" --silent
```

`in:` labels:

```bash
gh label list --search "in:" --limit 50 --json name --jq '.[].name'
gh issue edit {issue-number} --add-label "in: {module}"
```

Only add relevant `in:` labels. Do not remove existing `in:` labels, and do not fail Issue creation when `in:` labels are unavailable or irrelevant.

Skip unavailable labels, Issue Types, or milestones without failing the Issue creation flow.
