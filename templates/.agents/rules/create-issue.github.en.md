# Issue Creation

After `create-task` writes the local `task.md`, follow this rule to cascade Issue creation. This rule is referenced internally by `create-task` SKILL.md only; do not invoke it standalone.

## Boundary

- Issue title and body must come from `task.md` only
- Do not read `analysis.md`, `plan.md`, `implementation.md`, or any review artifact
- Persistent outputs are limited to the remote Issue and the `issue_number` written back to `task.md`
- If Issue creation fails, do not roll back `task.md`; the current task remains valid for the workflow, and the user can later manually fill `issue_number` so other skills' cascade sync takes over

## Steps

### 1. Verify Prerequisites

- `.agents/workspace/active/{task-id}/task.md` must exist
- Read `.agents/rules/issue-pr-commands.md` first and run its authentication and platform detection commands to confirm `gh auth status` and the current repository are usable
- Read `.agents/rules/issue-sync.md` first and complete `upstream_repo`, `has_triage`, and `has_push` detection; reuse these variables for every later `gh issue` and repo-level `gh api` call
- If `task.md` already has a non-empty, non-`N/A` `issue_number`, halt the cascade immediately: return "Task already linked to Issue #{n}, skipping creation" to `create-task` and let it decide how to continue

### 2. Extract Task Information

Pull the following from `task.md`:

- Task title (the first `# ` heading, stripped of `任务：` / `Task:` prefixes)
- The `## Description` / `## 描述` section
- The `## Requirements` / `## 需求` section
- frontmatter fields `type` and (optionally) `milestone`

Build the Issue title:

| task.md `type` | Conventional Commits type |
|---|---|
| `feature` | `feat` |
| `bugfix`, `bug` | `fix` |
| `refactor`, `refactoring` | `refactor` |
| `docs`, `documentation` | `docs` |
| `chore`, `task`, others | `chore` |

Scope inference: read known module names from `.agents/.airc.json`'s `labels.in` field, then semantically match them against the task title and description; omit `scope` when there is no clear hit. Final title: `{cc_type}({scope}): {task_title}` or `{cc_type}: {task_title}` (preserve the task title verbatim — do not translate or rewrite).

### 3. Build the Issue Body

Issue Form detection: follow the "Issue Template Detection" section in `.agents/rules/issue-pr-commands.md` to scan `.github/ISSUE_TEMPLATE/*.yml` (excluding `config.yml`).

#### Scenario A: A matching template was detected

Pick the form whose `name` (or filename) best matches the task type (e.g., a task with `type: bugfix` prefers a form whose name contains `bug`); if no match, fall back to a generic form like `other.yml`; if none, take the first form in the directory.

Populate the form by following the field-handling rules in `.agents/rules/issue-pr-commands.md` § "Issue Template Detection":

- `textarea` / `input` fields: use `attributes.label` as a markdown heading and pull values from task.md
- `markdown` fields: skip (these are description blurbs)
- `dropdown` / `checkboxes` fields: skip

Recommended field-to-source mapping:

| Template field hint | Source in task.md |
|---|---|
| `summary`, `title` | task title |
| `description`, `problem`, `what happened`, `issue-description`, `current-content` | task description |
| `solution`, `requirements`, `steps`, `suggested-content`, `impact`, `context`, `alternatives`, `expected` | requirements list (preserve checked / unchecked state as-is) |
| Other `textarea` / `input` fields | task description, or `N/A` if missing |

Whenever task.md does not provide a usable value, write `N/A`.

#### Scenario B: No template, or template parsing failed

Fall back to the default body:

```markdown
## Description

{task description, or N/A if missing}

## Requirements

- [ ] {requirement-1}
- [ ] {requirement-2}
```

If the requirements list is empty, write `N/A` in that section.

### 4. Resolve labels / Issue Type / milestone

#### labels (rough pass)

- Call `gh api "repos/$upstream_repo/labels?per_page=100" --jq '.[].name'` to fetch the actual labels in the repo (cache as a set)
- Pick the "expected type label" using the mapping below, keeping only those that exist in the repo set:

  | task.md `type` | label |
  |---|---|
  | `bug`, `bugfix` | `type: bug` |
  | `feature` | `type: feature` |
  | `enhancement` | `type: enhancement` |
  | `docs`, `documentation` | `type: documentation` |
  | `dependency-upgrade` | `type: dependency-upgrade` |
  | `task`, `chore` | `type: task` |
  | `refactor`, `refactoring` | `type: enhancement` |
  | others | skip |

- `in:` labels (rough pass — when in doubt, leave it out): semantically match the task title and description against module names from `labels.in`; explicit mention or strong implication → add `in: {module}`; vague or uncertain → skip. `in:` labels also require the label to actually exist in the repo.

If the final label set is empty, omit the `--label` argument.

#### Issue Type fallback

| task.md `type` | Issue Type |
|---|---|
| `bug`, `bugfix` | `Bug` |
| `feature`, `enhancement` | `Feature` |
| `task`, `documentation`, `dependency-upgrade`, `chore`, `docs`, `refactor`, `refactoring`, others | `Task` |

When applying the Issue Type, follow the "Set Issue Type" command in `.agents/rules/issue-pr-commands.md`; first call `gh api orgs/{owner}/issue-types` to list the org's actually available Types, and only set the inferred value when it is present in that list. Failure to set is non-blocking.

#### milestone

Infer per `.agents/rules/milestone-inference.md` § "Stage 1: `create-task` (when the platform rule creates the Issue)". When the inference is empty or the repo lacks a matching milestone, omit the milestone.

### 5. Call the GitHub CLI to Create the Issue

Run the "Create Issue" command from `.agents/rules/issue-pr-commands.md`:

```bash
gh issue create -R "$upstream_repo" \
  --title "{title}" \
  --body "{body}" \
  --assignee @me \
  {label-args} \
  {milestone-arg}
```

- `{label-args}` is expanded from the result of §4 into multiple `--label "..."`; if empty, omit the entire argument
- `{milestone-arg}` is only expanded to `--milestone "..."` when `has_triage=true` and milestone is non-empty; otherwise omit
- `--assignee @me` requires no permission probe; on failure, skip silently

Permission downgrade follows `.agents/rules/issue-sync.md`: `has_triage=false` skips label / milestone settings; `has_push=false` skips Issue Type setting; the rest continues.

After success, parse the Issue number from the output (match only the `https://.../issues/(\d+)` URL form; do not use a loose regex). If parsing fails, halt the cascade and propagate the error back to `create-task`.

### 6. Set Issue Type (Optional)

Execute only when `has_push=true` and the Issue Type inferred in §4 is in the org's actually available list:

```bash
gh api "repos/$upstream_repo/issues/{issue-number}" -X PATCH \
  -f type="{issue-type}" --silent
```

Failure is non-blocking.

### 7. Write Back task.md

Update task.md:

- Write `issue_number: {n}` into the frontmatter (replace if it exists; append at the end of the frontmatter otherwise)
- Update `updated_at` to the current time (command: `date "+%Y-%m-%d %H:%M:%S%:z"`)
- Append to the `## 活动日志` / `## Activity Log` section:
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Create Issue** by {agent} — Created GitHub Issue #{n}
  ```

### 8. Return the Result

Hand the following back to the caller `create-task`:

- Issue number `{n}`
- Issue URL (prefer the URL printed by `gh issue create`; fall back to `https://github.com/$upstream_repo/issues/{n}`)
- The labels / milestone / Issue Type that were actually applied

`create-task` uses these to pick the "Scenario A: Issue created" output branch and continue with task comment sync and status label setup.

## Error Handling

- Auth failure / command unavailable: return a structured `{code: "AUTH_FAILED", message}` to `create-task`; do not modify task.md
- Network timeout / DNS failure: `{code: "NETWORK", message}`
- Template parsing failure, Issue number parsing failure, other anomalies: `{code: "VALIDATION", message}`
- All failures keep task.md untouched; `create-task` takes the "Scenario C: failure fallback" output branch and prompts the user to retry manually or fill `issue_number` later
