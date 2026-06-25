# Issue Creation

After `create-task` writes the local `task.md`, follow this rule to cascade Issue creation. This rule is referenced internally by `create-task` SKILL.md only; do not invoke it standalone.

## Boundary

- Issue title and body must come from `task.md` only
- Do not read `analysis.md`, `review-analysis.md`, `plan.md`, `review-plan.md`, `code.md`, or any review-code artifact
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

- Task title (the first `# ` heading, stripped of `任务：` / `Task:` prefixes) — used to build the Issue title
- frontmatter fields `type` and (optionally) `milestone`

> The Issue **body** is not extracted by hand here. It is generated deterministically in §3 by the `ai task issue-body` command from the `## 描述` / `## 需求` sections; callers must not assemble it themselves.

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

> **Mechanization boundary (mandatory)**: the Issue body is always produced deterministically by the `ai task issue-body` command; callers only pass the command's stdout to `gh issue create` via `--body-file` and must **not** assemble, rewrite, or truncate the body themselves. The command emits only the task title / `## 描述` / `## 需求` content; every other task.md scaffolding section never enters the body.

Issue Form detection: follow the "Issue Template Detection" section in `.agents/rules/issue-pr-commands.md` to scan `.github/ISSUE_TEMPLATE/*.yml` (excluding `config.yml`).

#### Scenario A: A matching template was detected

Pick the form whose `name` (or filename) best matches the task type (e.g., a task with `type: bugfix` prefers a form whose name contains `bug`); if no match, fall back to a generic form like `other.yml`; if none, take the first form in the directory.

Once the form file `{form-path}` is chosen, let the command render the final body from that Issue Form and write it to the body file `{body-file}` for §5:

```bash
ai task issue-body {task-id} --template "{form-path}" > "{body-file}"
```

The command skips `markdown` / `dropdown` / `checkboxes` fields and, for `input` / `textarea` fields, uses `attributes.label` as the heading and deterministically fills the task title / description / requirements by field `id`, writing `N/A` for fields with no reliable source (the field mapping table is the single source of truth inside the command and is not restated here). When the command exits non-zero (missing file / invalid YAML / no `body`), regenerate `{body-file}` with the Scenario B command instead.

#### Scenario B: No template, or template parsing failed

Let the command emit the default body (only `## 描述` + `## 需求`, checkbox text preserved verbatim, missing sections filled with `N/A`) into `{body-file}`:

```bash
ai task issue-body {task-id} > "{body-file}"
```

#### Red line: never use the entire task.md as the body

In both Scenario A and B, the body may only come from `ai task issue-body` stdout and contains **only the description + requirements content** (Scenario A is the equivalent content mapped onto template fields).

Wrong example (❌ forbidden): pasting the entire task.md — including scaffolding sections such as `## 分析` / `## 设计` / `## 实现备注` / `## 审查反馈` / `## 审查分歧账本` / `## 人工裁决` / `## 活动日志` / `## 完成检查清单` and `#XXX` placeholders — directly as the Issue body. Those sections only go to the `sync-issue:{task-id}:task` comment, never the body.

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

**Mandatory; do not skip.** This section expands `.agents/rules/milestone-inference.md` Phase 1 in place and keeps the same semantics; do not treat it as optional inference.

Select the milestone using these numbered steps, with priority strictly aligned to Phase 1:

1. If `has_triage=false`: omit `--milestone` immediately and skip this section.
2. List all open milestones in the repository:
   ```bash
   gh api "repos/$upstream_repo/milestones?state=open&per_page=100" \
     --jq '.[].title'
   ```
3. If task.md frontmatter explicitly provides a `milestone` field and that value appears in the step 2 list: use that value directly as `{milestone-arg}` and skip steps 4 / 5.
4. Filter the step 2 result with `^[0-9]+\.[0-9]+\.x$`.
   - Non-empty: sort by major and minor numerically, then choose the smallest release line as `{milestone-arg}`.
5. If step 4 has no candidates: fall back to `General Backlog`.
   - `General Backlog` exists in the step 2 result: use that milestone.
   - `General Backlog` does not exist: omit `--milestone` only in this case.
6. If the step 2 `gh api` call fails (network / authentication error): handle it as "no candidates" and continue to step 5.

When a milestone is selected, pass the release line (or `General Backlog` or the explicit task.md value) as `{milestone-arg}` to the `gh issue create` command in step 5; keep the expansion rule at the end of §5 unchanged.

### 5. Call the GitHub CLI to Create the Issue

Run the "Create Issue" command from `.agents/rules/issue-pr-commands.md`; always use the `{body-file}` produced in §3, overriding the generic command's `--body`:

```bash
gh issue create -R "$upstream_repo" \
  --title "{title}" \
  --body-file "{body-file}" \
  --assignee @me \
  {label-args} \
  {milestone-arg}
```

- `{body-file}` is the body file produced in §3 by `ai task issue-body`; do **not** switch back to `--body` and assemble the body by hand
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

### 7. Set Issue Fields (Optional)

If `has_push=true`, read `.agents/rules/issue-fields.md` and follow Flow A to write any applicable non-empty `priority`, `effort`, `start_date`, and `target_date` values from `task.md`.

Field write failures are non-blocking.

### 8. Write Back task.md

Update task.md:

- Write `issue_number: {n}` into the frontmatter (replace if it exists; append at the end of the frontmatter otherwise)
- Update `updated_at` to the current time (command: `date "+%Y-%m-%d %H:%M:%S%:z"`)

> Do NOT append an Activity Log entry here. The Issue creation event is already captured by the GitHub Issue itself and by the frontmatter `issue_number` field; the Activity Log only records the single `create-task` skill execution anchor (`Create Task`), written by the caller SKILL step 3.

### 9. Return the Result

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
