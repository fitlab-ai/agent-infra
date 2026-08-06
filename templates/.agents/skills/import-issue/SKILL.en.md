---
name: import-issue
description: >
  Import an Issue and create a task.
  Use when you want to start work from an existing Issue and track it locally.
---

# Import Issue
> `--agent` values follow the "Collaborator Token Specification" in `.agents/rules/task-management.md`: standard AI short tokens (`claude`/`codex`/`gemini`/`opencode`/`cursor`), long-name normalization (`claude-code`->`claude`, `gemini-cli`->`gemini`), or the `human` manual exception.


Import the specified Issue and create a task. Argument: issue number.

## Boundary / Critical Rules

- The only output is `task.md`
- Do not write or modify business code; import only
- After executing this skill, you **must** immediately update task status

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Step Start: Capture the Start Time

This skill **creates** task.md, so there is no file to write at the start. Capture `started_at` in memory before running (`date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'`); when writing the Activity Log at the end, **append both lines at once** — the started line uses `started_at`, the done line uses the completion time, both sharing the base action (started line action gets a ` [started]` suffix, note `started`). The base action must match the actual import scenario:

```
# Scenario B: new Issue import
- {started_at} — **Import Issue [started]** by {agent} — started
- {done_at} — **Import Issue** by {agent} — {completion summary}

# Scenario C: recovery from historical Issue comments
- {started_at} — **Import Issue (Recovered) [started]** by {agent} — started
- {done_at} — **Import Issue (Recovered)** by {agent} — {completion summary}
```

`ai task log` pairs the two by base action onto one row (in progress → done). See the "Activity Log started / done dual-marker convention" in `.agents/rules/task-management.md`.

## Execution Flow

### 1. Retrieve Issue Information

Read `.agents/rules/issue-pr-commands.md` first, follow its prerequisite steps to complete authentication and code-hosting platform detection, then load the Issue data with its "Read an Issue" command.

Extract: issue number, title, description, and labels.

Derive the task title from the Issue title by stripping an optional single leading Conventional Commits prefix, following the contract below; preserve the rest of the description verbatim and in its original language. This fenced contract is the authoritative, language-neutral rule — keep it byte-for-byte identical across every `import-issue` variant:

```
# title-derivation-contract
strip-prefix: type(scope):
prefix-types: feat fix docs style refactor perf test build ci chore revert
single-layer-only: true
preserve-body-colon: true
keep-when-no-prefix: true
example-strip: "feat(meta): create-pr summary" => "create-pr summary"
example-keep: "修复某问题" => "修复某问题"
example-single-layer: "feat: add A: B" => "add A: B"
```

Strip only the first layer, and only when the leading token is a `prefix-types` value optionally followed by `(scope)` and a `!`, then `:` and at least one space; a colon inside the description is never a prefix.

### 2. Check for an Existing Task

2.1 Search `.agents/workspace/active/` for an existing task linked to this Issue.
- If found, **reuse the existing task by default** (Scenario A); do not ask the user. State clearly in the final notice: "Reused existing task `{task-id}`; not re-imported." If the user wants to re-import, they must first archive or delete the existing task and run this skill again
- If not found, continue to 2.2

2.2 Run `agent-infra-internal platform-comment list --issue {issue-number}` to scan registered markers for a recoverable historical task ID.

This command depends on `$upstream_repo` being set in step 1.

Exit code handling for the whole pipeline:

- Exit 0 + output `found=false`: create a new task through the normal import flow
- Exit 0 + output `found=true`: reuse `task_id`
- Non-zero exit (platform API, authentication, JSON parsing, or any pipeline segment failure): treat it as platform API degradation; show stderr to the user, then continue with the new-task import flow without blocking

### 3. Create the Task Directory and File

3.1 Decide the task ID and `created_at`.

| Scenario | Trigger | task ID source | created_at source | User confirmation |
|---|---|---|---|---|
| Scenario A | 2.1 finds a local task | Reuse local ID | Preserve local value | Reuse by default; do not ask; inform the user reuse happened |
| Scenario B | 2.1 no match + 2.2 no candidate | Create with `date +%Y%m%d-%H%M%S` | Current time | Not required |
| Scenario C | 2.1 no match + 2.2 any candidate | Automatically reuse the earliest candidate ID | Prefer remote frontmatter `created_at`; use current time if missing | Inform only |

```bash
date +%Y%m%d-%H%M%S
```

3.2 Write the task directory and `task.md`.

- Create the directory: `.agents/workspace/active/{task-id}/`
- Use the `.agents/templates/task.md` template to create `task.md`
- For Scenario C, prefer `type`, `workflow`, `branch`, and `milestone` from the remote frontmatter; infer missing or damaged fields from Issue labels and current rules
- Always write `current_step` as `requirement-analysis`; do not restore the remote original `current_step`

Task metadata:
```yaml
id: {task-id}
issue_number: <issue-number>
type: feature|bugfix|refactor|docs|chore
branch: <project>-<type>-<slug>
workflow: feature-development|bug-fix|refactoring
status: active
created_at: {YYYY-MM-DD HH:mm:ss±HH:MM}
updated_at: {YYYY-MM-DD HH:mm:ss±HH:MM}
agent_infra_version: {agent_infra_version}
priority:                  # optional; preserve source/frontmatter value when available
effort:                    # optional; preserve source/frontmatter value when available
start_date:                # optional; preserve explicit YYYY-MM-DD when available
target_date:               # optional; preserve explicit YYYY-MM-DD when available
current_step: requirement-analysis
assigned_to: {current AI agent}
```

Optional Issue field metadata should preserve recovered or explicit source values. If absent, leave it empty; do not invent dates.

3.3 Append Activity Log entries.

- Scenario B: append `Import Issue`
- Scenario C: append `Import Issue (Recovered)` and include the recovered task ID, any recoverable original `current_step`, original `assigned_to`, and that `current_step` was reset to `requirement-analysis`; if some frontmatter fields are missing or damaged, mention the fallback in the same entry

### 4. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `current_step`: requirement-analysis
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- `agent_infra_version`: value from `.agents/rules/version-stamp.md`
- `## Context` -> `- **Branch**:`: update it to the generated branch name
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Import Issue** by {agent} — Issue #{number} imported
  ```
  If step 3.3 already appended recovery Activity Log entries, do not append a duplicate equivalent entry.

### 5. Bind and Sync the Issue

If task.md contains a valid `issue_number`, perform these sync actions (skip and continue on any failure):
- Run `agent-infra-internal platform-issue bind {task-id} --issue {issue-number} --agent {standard-agent-token}`
- Run `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --assignees current --milestone initial`
- After every scenario, run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`

### 6. Verification Gate

**Allocate short id first** (ensures the registry entry is allocated; the validation gate will read it):

```bash
node .agents/scripts/task-short-id.js alloc "$task_id"
```

If this fails (non-zero exit), follow the message — archive some active tasks or raise `task.shortIdLength` — and do NOT continue.

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
agent-infra-internal task-verify {task-id} import-issue.completed --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 7. Inform User

> Execute this step only after the verification gate passes.

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill analyze-task --task-ref {task-ref}`.

```
Issue #{number} imported.

Task information:
- Task ID: {task-id} (short id {task-ref})
- Title: {title}
- Workflow: {workflow}

Output file:
- Task file: .agents/workspace/active/{task-id}/task.md

Next step - run requirements analysis:
{next-step-commands}
```



## Completion Checklist

- [ ] Created the task file `.agents/workspace/active/{task-id}/task.md`
- [ ] Recorded `issue_number` in task.md
- [ ] Updated `current_step` to requirement-analysis
- [ ] Updated `updated_at` to the current time
- [ ] Appended an Activity Log entry to task.md
- [ ] Synced the task comment to the Issue, with remote content matching local task.md
- [ ] Rendered the selected next-step commands through the shared helper
- [ ] **Did not modify any business code**

## STOP

After completing the checklist, **stop immediately**. Do not continue to later steps.

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Notes

1. **Issue validation**: verify that the Issue exists before continuing
2. **Duplicate task**: if this Issue already has a linked task, **reuse it by default** instead of creating a new one (do not ask the user)
3. **Next step**: after import, run `analyze-task` before `plan-task`

## Error Handling

- Issue not found: output "Issue #{number} not found, please check the issue number"
- Network error: output "Cannot connect to the platform, please check network"
- Permission error: output "No access to this repository"
