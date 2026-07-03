# Next-Step Output Rule

This file defines three **independent** rules for a skill's "notify-user / Next steps" output (the 3rd applies to review-* only); read this file before rendering the final output and apply whichever rules apply:

1. **Next-step output structure**: how "Next steps" commands and the "Task info" block present the task ID (placeholders / short-id lookup / fallback).
2. **Agent output trailing line (Completed at)**: the **very last line** of user-facing output, **independent of the "Next steps" block**, applying to normal / error / early-return paths alike.
3. **Pending human-decision pre-block**: applies only to `review-analysis` / `review-plan` / `review-code` when this stage has pending rulings (`{h} > 0`) — expand the pending items before the "Next steps" commands and prompt to resolve them first.

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
- Position: it must be the last line of the entire user-facing output, after all "Next steps" commands. If a scenario has a conditional reminder line after the commands (e.g. the manual-validation reminder), the completion line goes after that reminder.
- This line is for terminal scanning only; it is never written to any artifact file or Issue/PR comment. The single source of truth for completion time remains the Activity Log in task.md.

## Pending human-decision pre-block (review-* only, when {h} > 0)

This section is a **third standalone rule, co-equal with the two above**, used only by the "notify-user / report conclusion" step of `review-analysis` / `review-plan` / `review-code`.

`{h}` has the same meaning as the count line in each review skill's `reference/output-templates.md`: the number of rows in task.md `## 审查分歧账本` (Review Disagreement Ledger) for **this stage** (`stage ∈ {analysis|plan|code}`) whose `status = needs-human-decision` — **pending items only, excluding rows already `human-decided`**.

- **`{h} = 0`**: do not emit this block; render "Next steps" exactly as the selected output-templates scenario.
- **`{h} > 0`**: insert the block below **before** the selected scenario's "Next steps - <stage>" commands; the next-stage commands are still listed after the block.

```text
⚠️ Pending human decisions ({h}) — please rule on each before continuing to the next stage:
  - {ledger-id} ({stage}/{severity}): {summary}
    Location: the matching row in task.md `## 审查分歧账本` · Evidence: {evidence}
  …(one entry per status=needs-human-decision row of this stage in task.md `## 审查分歧账本`)

View details:
  - All pending decisions: ai task decisions {task-ref}
  - A single item's full background/options/impact/recommendation: ai task decisions {task-ref} <ordinal|HD-id>

To resolve:
  1. In the task.md `## 人工裁决` section, record your ruling and rationale for each item above.
  2. Flip the status of the matching row in `## 审查分歧账本` from `needs-human-decision` to `human-decided`.

Note: until all those rows are flipped to `human-decided`, running the next-stage command directly will be blocked by gates such as complete-task (`needs-human-decision` is non-terminal). The next-stage commands are still listed below for use after the decisions are made.
```

Field values: `{ledger-id}` / `{stage}` / `{severity}` / `{evidence}` come from the same-named columns of the matching `## 审查分歧账本` row; `{summary}` comes from the artifact anchor referenced by `{evidence}` (e.g. the decision title at `plan.md#HD-1`), falling back to a one-line summary of the finding when no anchor title exists.
