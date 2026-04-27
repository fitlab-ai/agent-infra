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

Map task types to labels and Issue Types, but keep only labels that actually exist.

Fallback label mapping:

| task.md type | label |
|---|---|
| `bug`, `bugfix` | `type: bug` |
| `feature` | `type: feature` |
| `enhancement` | `type: enhancement` |
| `docs`, `documentation` | `type: documentation` |
| `dependency-upgrade` | `type: dependency-upgrade` |
| `task`, `chore` | `type: task` |
| `refactor`, `refactoring` | `type: enhancement` |
| other values | skip |

Issue Type fallback mapping:

| task.md type | Issue Type |
|---|---|
| `bug`, `bugfix` | `Bug` |
| `feature`, `enhancement` | `Feature` |
| `task`, `documentation`, `dependency-upgrade`, `chore`, `docs`, `refactor`, `refactoring`, and all other values | `Task` |

## Create the Issue

Before creating the Issue, read `.agents/rules/issue-pr-commands.md` and use its "Create an Issue" command template.

Before calling the creation command, follow `.agents/rules/issue-sync.md` / `.agents/rules/issue-pr-commands.md` to complete the prerequisite authentication and code-hosting platform detection steps.

If no valid labels remain, omit label arguments.

For milestone inference, read `.agents/rules/milestone-inference.md` and follow "Phase 1: `create-issue`" before creating the Issue.

Issue Type setup follows the matching commands in `.agents/rules/issue-pr-commands.md`.

- handle direct writes for labels, milestones, `in:` labels, and Issue Type by following the permission-degradation rules in `.agents/rules/issue-pr-commands.md` and `.agents/rules/issue-sync.md`
- when those rules say to skip a direct write, continue without failing Issue creation

`in:` labels (coarse selection):

Prepare label edit arguments by following the Issue update command in `.agents/rules/issue-pr-commands.md`.

Use the returned labels to do semantic matching against the task.md title and description:
- add a label when the task **explicitly mentions** a module (for example, "fix CLI argument parsing" -> `in: cli`)
- add a label when the task **strongly implies** a module
- skip the label when the mapping is ambiguous or uncertain

Principle: prefer missing labels over wrong labels. Coarse selection does not need to be perfect because implement-task / create-pr will refine `in:` labels from actual changed files later.

Handle relevant `in:` labels by following the permission-degradation rules in `.agents/rules/issue-sync.md`. Do not fail Issue creation when `in:` labels are unavailable, irrelevant, or skipped by those rules.

Skip unavailable labels, Issue Types, or milestones without failing the Issue creation flow.
