---
name: check-task
description: >
  Check a task's current status and progress.
  Use when you want a quick view of a task's current status and progress.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Check Task Status

## Boundary / Critical Rules

- This skill is **read-only** -- do not modify any files
- Mechanical facts (frontmatter metadata, artifact grouping, git/platform state, and locating the task across the active, blocked, and completed directories) are delegated to the deterministic `ai task status` command. This skill only adds the semantic layer the CLI cannot produce: workflow-stage interpretation and review-verdict parsing; the next action comes directly from the CLI's canonical recommendation.

## Task Context Resolution

> The entry point may omit the task ref; explicit task scope accepts only `--task <ref>` or `-t <ref>`, and positional task refs are not interpreted. Preserve every other business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to the full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Steps

### 1. Gather Facts via `ai task status`

Run the deterministic CLI to collect every mechanical fact, and use its stdout as the factual base of your report:

```bash
ai task status --task {task-id}
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
- For the latest review artifact of each stage (`review-analysis`, `review-plan`, `review-code`), read the report body and parse its conclusion: the overall verdict (Approved / Changes Requested / Rejected) and the blocker / major / minor counts. Use these conclusions only to explain stage status; do not recompute the next action from them.

Present the workflow progress as an overlay on top of the CLI output, marking the latest round and the parsed review verdict, for example:

```
Workflow progress:
  [done]       Requirement Analysis  analysis.md (Round 1, latest)
  [done]       Analysis Review       review-analysis.md (Round 1, latest, Approved)
  [current]    Technical Design      plan.md (Round 1)
  [pending]    Plan Review
```

### 3. Display the canonical recommendation

Read only `Recommendation.action` from the `ai task status --task {task-id}` output and use it as the sole source of the next action. Do not recompute an action from `current_step`, the latest files, review prose, or the Activity Log.

When the action is non-empty, perform only this literal action-to-skill conversion, then invoke the shared helper once:

| Recommendation.action | next skill |
|-----------------------|------------|
| `analysis` | `analyze-task` |
| `plan` | `plan-task` |
| `code` | `code-task` |
| any other action | same-named skill |

When the action is empty, do not invoke the helper; state that no next skill is currently recommended. Before rendering the final output, read `.agents/rules/next-step-output.md`; invoke `agent-infra-internal agent-client next-steps --skill {next-skill} --task-ref {task-ref}` and render stdout verbatim as `{next-step-commands}`. Append the `Completed at` trailing line last.

## Notes

1. **Read-only**: This skill only reads and reports -- it does not modify files
2. **CLI delegation**: mechanical facts (metadata, artifact grouping, git/platform state, multi-directory location) come from `ai task status`; this skill adds the semantic interpretation on top
3. **Quick reference**: Use this skill any time you need to see where a task is in the workflow
4. **Versioned artifacts**: `ai task status` groups the actual artifact rounds; the semantic layer must still report the latest review verdict for `review-analysis`, `review-plan`, and `review-code`
