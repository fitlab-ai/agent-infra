---
name: check-task
description: "Check a task's current status and progress"
---

# Check Task Status

## Boundary / Critical Rules

- This skill is **read-only** -- do not modify any files
- Mechanical facts (frontmatter metadata, artifact grouping, git/platform state, and locating the task across the active, blocked, and completed directories) are delegated to the deterministic `ai task status` command. This skill only adds the semantic layer the CLI cannot produce: workflow-stage interpretation, review-verdict parsing, and the next-step recommendation.

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Steps

### 1. Gather Facts via `ai task status`

Run the deterministic CLI to collect every mechanical fact, and use its stdout as the factual base of your report:

```bash
ai task status {task-id}
```

The command resolves the task across the active, blocked, and completed directories and prints five sections: the task header (`id`, short id, title), `Metadata` (frontmatter fields), `Artifacts` (files grouped by workflow stage), `Git` (branch match, uncommitted count, ahead/behind), and `Platform` (Issue/PR state). Treat that output as authoritative -- do not re-derive any of it by hand.

Fallbacks:
- If the command is unavailable (e.g. `ai` is not on PATH or `dist/` is not built) or exits non-zero, fall back to a degraded read: show the `task.md` frontmatter and `ls` the task directory, and tell the user the output is degraded (suggest building or installing the CLI, e.g. `ai init`).
- If the task is not found in any directory, prompt "Task {task-id} not found".

### 2. Interpret Workflow Stage & Review Verdicts

This is the semantic layer the CLI does not produce. Using the `Artifacts` groups from step 1 and the Activity Log in `task.md`:

- Map each workflow stage to a status indicator plus its latest artifact and round:
  - `[done]` - step completed
  - `[current]` - currently in progress
  - `[pending]` - not started yet
  - `[blocked]` - blocked
  - `[skipped]` - skipped
- For the latest review artifact of each stage (`review-analysis`, `review-plan`, `review-code`), read the report body and parse its conclusion: the overall verdict (Approved / Changes Requested / Rejected) and the blocker / major / minor counts. The CLI does not parse review bodies, so this reading is required to choose the next action in step 3.

Present the workflow progress as an overlay on top of the CLI output, marking the latest round and the parsed review verdict, for example:

```
Workflow progress:
  [done]       Requirement Analysis  analysis.md (Round 1, latest)
  [done]       Analysis Review       review-analysis.md (Round 1, latest, Approved)
  [current]    Technical Design      plan.md (Round 1)
  [pending]    Plan Review
```

### 3. Recommend Next Action

Recommend the appropriate next skill based on the current workflow state. You must show command formats for all TUI columns in the table below, not just the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

> **⚠️ CONDITION CHECK — you must choose the single matching row in the table below based on `status`, `current_step`, the latest artifacts, and the latest review result:**
>
> - `status = blocked` -> choose "Task Blocked"
> - `status = completed` -> choose "Task Completed"
> - `current_step = requirement-analysis` and the latest analysis artifact is complete -> choose "Analysis Complete"
> - `current_step = requirement-analysis-review` and the latest analysis review artifact is approved -> choose "Analysis Review Passed"
> - `current_step = requirement-analysis-review` and the latest analysis review artifact exists but is not approved or has findings -> choose "Analysis Review Has Issues"
> - `current_step = technical-design` and the latest plan artifact is complete -> choose "Plan Complete"
> - `current_step = technical-design-review` and the latest plan review artifact is approved -> choose "Plan Review Passed"
> - `current_step = technical-design-review` and the latest plan review artifact exists but is not approved or has findings -> choose "Plan Review Has Issues"
> - The latest code artifact exists and there is still no latest code review artifact -> choose "Code Complete"
> - `current_step = code-review` and the latest code review artifact exists, the verdict is `Approved`, and `Blocker = 0`, `Major = 0`, `Minor = 0` -> choose "Code Review Passed"
> - `current_step = code-review` and the latest code review artifact exists, but any `Blocker`, `Major`, or `Minor` issue remains, or the verdict is not a clean approval -> choose "Code Review Has Issues"
>
> **Important: if the latest review report contains any issue at all, do not use the corresponding review-passed row. Use the corresponding has-issues row instead.**
>
> Before rendering the final output, read `.agents/rules/next-step-output.md` and apply both of its rules: (1) render `{task-ref}` in the table commands below as the short id `#NN` (falling back to the full TASK-id when unallocated or released); (2) append the `Completed at` line as the very last line of the user-facing output (this applies to every user-facing output — success, error, and early-return paths alike, not only the success path).

| Current State              | Claude Code / OpenCode                              | Gemini CLI                               | Codex CLI                                           |
|----------------------------|-----------------------------------------------------|------------------------------------------|-----------------------------------------------------|
| Analysis Complete          | `/review-analysis {task-ref}`                        | `/{{project}}:review-analysis {task-ref}` | `$review-analysis {task-ref}`                        |
| Analysis Review Passed     | `/plan-task {task-ref}`                              | `/{{project}}:plan-task {task-ref}`       | `$plan-task {task-ref}`                              |
| Analysis Review Has Issues | `/analyze-task {task-ref}`                           | `/{{project}}:analyze-task {task-ref}`    | `$analyze-task {task-ref}`                           |
| Plan Complete              | `/review-plan {task-ref}`                            | `/{{project}}:review-plan {task-ref}`     | `$review-plan {task-ref}`                            |
| Plan Review Passed         | `/code-task {task-ref}`                              | `/{{project}}:code-task {task-ref}`       | `$code-task {task-ref}`                              |
| Plan Review Has Issues     | `/plan-task {task-ref}`                              | `/{{project}}:plan-task {task-ref}`       | `$plan-task {task-ref}`                              |
| Code Complete              | `/review-code {task-ref}`                            | `/{{project}}:review-code {task-ref}`     | `$review-code {task-ref}`                            |
| Code Review Passed         | `/commit`                                           | `/{{project}}:commit`                    | `$commit`                                           |
| Code Review Has Issues     | `/code-task {task-ref}`                              | `/{{project}}:code-task {task-ref}`       | `$code-task {task-ref}`                              |
| Task Blocked               | Unblock the task or provide the missing information | —                                        | Unblock the task or provide the missing information |
| Task Completed             | No action needed                                    | —                                        | No action needed                                    |

## Notes

1. **Read-only**: This skill only reads and reports -- it does not modify files
2. **CLI delegation**: mechanical facts (metadata, artifact grouping, git/platform state, multi-directory location) come from `ai task status`; this skill adds the semantic interpretation on top
3. **Quick reference**: Use this skill any time you need to see where a task is in the workflow
4. **Versioned artifacts**: `ai task status` groups the actual artifact rounds; the semantic layer must still report the latest review verdict for `review-analysis`, `review-plan`, and `review-code`
