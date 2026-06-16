# Next-Step Output Rule

This file defines two **independent** rules for a skill's "notify-user / Next steps" output; read this file before rendering the final output and apply both:

1. **Next-step output structure**: how "Next steps" commands and the "Task info" block present the task ID (placeholders / short-id lookup / fallback).
2. **Agent output trailing line (Completed at)**: the **very last line** of user-facing output, **independent of the "Next steps" block**, applying to normal / error / early-return paths alike.

## Placeholder semantics

| Placeholder | Meaning | Rendered form |
|-------------|---------|---------------|
| `{task-ref}` | Current task **short id** | `#`-prefixed, e.g. `#15`; falls back to the full `TASK-id` when unavailable |
| `{task-id}` | Current task **full id** | `TASK-YYYYMMDD-HHMMSS` |

## Scope

- **Next-step TUI commands** (`/analyze-task`, `/{{project}}:review-code`, `$create-pr`, etc., including commands inside Markdown table cells) → always use `{task-ref}` (short id).
- **"Task info" / "Task status" structured field lines** → show full id and short id together: `- Task ID: {task-id} (short id {task-ref})`.
- **Report titles** (`Task {task-id} ... completed`) and **artifact paths** (`.agents/workspace/active/{task-id}/...`) → keep the full `{task-id}` (physical path and archive key, must not change).

## Obtaining the short id (`{task-ref}`)

The single source of truth for short ids is the registry `.agents/workspace/active/.short-ids.json` (via `task-short-id.js`). **Never** read the `short_id` field from task.md frontmatter (that field is not authoritative).

Once the full `$task_id` is resolved, use the snippet below to look up the short id; it returns `#NN` on hit and falls back to the full `TASK-id` on miss:

```bash
task_ref=$(node -e '
const cp=require("child_process");
const out=cp.execSync("node .agents/scripts/task-short-id.js list",{encoding:"utf8"});
const ids=(JSON.parse(out).ids)||{};
const full=process.argv[1];
const hit=Object.entries(ids).find(([,v])=>v===full);
process.stdout.write(hit?("#"+hit[0]):full);
' "$task_id")
# Example: $task_id=TASK-20260613-225809 -> task_ref=#15
```

## Fallback conditions

`{task-ref}` falls back to the full `TASK-id` in these cases (i.e. the registry has no matching short id):

- **Unallocated**: very early paths before `create-task` / `import-*` / `restore-task` has allocated a short id.
- **Released**: after a task is archived by `complete-task` / `cancel-task` / `block-task` / `close-codescan` / `close-dependabot`, its short id is immediately removed from the registry. The terminal/summary lines of these archival skills therefore fall back to the full `TASK-id` naturally, with no special-casing.

`restore-task` re-allocates a short id when restoring a task (possibly different from before); the snippet picks up the new short id.

## `#` prefix and shell quoting

Short ids are always rendered with a `#` prefix as `#NN`, matching how task.md frontmatter renders `short_id`. `#` starts a comment in bash, so pasting example commands depends on the TUI (both the bare numeric `NN` and `#NN` are accepted by `task-short-id.js resolve`).

## Agent output trailing line (Completed at)

This section is a standalone rule, **co-equal with the next-step output structure** and **not part of the "Next steps" block**. Every skill that renders user-facing output must append the completion-time line as the **very last line** of that output — including **complete-task, which renders no next-step commands**, and **error / early-return paths** where a precondition is unmet. This lets users scanning across tmux windows tell at a glance which agent finished most recently:

```text
Completed at: YYYY-MM-DD HH:mm:ss
```

- Value command (local timezone, no offset): `date "+%Y-%m-%d %H:%M:%S"`
- Position: it must be the last line of the entire user-facing output, after all "Next steps" commands. If a scenario has a conditional reminder line after the commands (e.g. the env-blocked reminder), the completion line goes after that reminder.
- This line is for terminal scanning only; it is never written to any artifact file or Issue/PR comment. The single source of truth for completion time remains the Activity Log in task.md.
