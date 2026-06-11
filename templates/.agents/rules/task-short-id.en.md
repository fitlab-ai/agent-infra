# Task short id

Task short ids let mobile-style SKILL invocations replace the full 22-char
`TASK-YYYYMMDD-HHMMSS` with `#N` while a task is active.

## Syntax

- Format: `^#\d+$` (e.g. `#1`, `#7`, `#42`). Pure digits only; no letters.
- `#0` is reserved and never allocated.
- Leading zeros are rejected (`#01` is invalid).
- The plain `TASK-…` form keeps working everywhere; the `#N` form is an alias,
  not a replacement for the persisted task id.

## Lifecycle

| Action     | When                                                                 | Effect on registry & task.md                                  |
|------------|-----------------------------------------------------------------------|---------------------------------------------------------------|
| alloc      | `create-task`, `import-issue`, `import-codescan`, `import-dependabot` | Assigns lowest free `#N`; writes `short_id` into task.md.     |
| resolve    | Lifecycle SKILLs (`analyze-task`, `plan-task`, `code-task`, …)        | Looks up `#N` → full task id. Does not allocate.              |
| release    | `complete-task`, `cancel-task`, `block-task`, `close-codescan`, `close-dependabot` | Removes the registry entry; leaves task.md `short_id` as a historical value. |
| re-alloc   | `restore-task`                                                        | Re-allocates a (possibly new) `#N` and writes it to task.md.  |

Short ids are valid only while a task lives in `.agents/workspace/active/`.
Once it is moved to `completed/`, `blocked/`, or `archive/`, the `#N` slot is
freed and may be reused by a new task.

## Configuration

```jsonc
// .agents/.airc.json
{
  "task": {
    "shortIdLength": 1  // default; capacity = 9 (#1–#9). Set to 2 for #1–#99.
  }
}
```

When all slots for the configured width are in use, `alloc` fails with a clear
error suggesting either archiving some tasks or raising `task.shortIdLength`.
There is no silent extension or truncation.

## `#N` resolution scope (split by entrypoint)

| Entrypoint                                                  | Hit                  | Miss                                                 |
|-------------------------------------------------------------|----------------------|------------------------------------------------------|
| SKILL parameter resolver (lifecycle SKILLs)                  | resolve to full id   | **strict error** — short id not found / invalid     |
| `ai sandbox enter '#N'` / `ai sandbox exec '#N' …`          | resolve to full id   | fall back to running-sandbox ls index (`#414`)      |

`list --verify` is strictly read-only: it reports discrepancies between active
dir, registry, and `short_id` declared in each `task.md`, but never writes.

## Error scenarios

- **Short id not found**: the registry has no entry for `#N`. Either the task
  was archived (release freed the slot) or the input is wrong.
- **Registry corruption** (duplicate registry entries for the same task id, or
  the JSON is unparsable): exit code 2; manual cleanup required.
- **Parameter format error** (e.g. `#0`, `#abc`, `#`): exit code 1.

## Cross-TUI quoting

Bash treats `#` as a comment marker. Always single-quote: `ai sandbox exec '#3' 'npm test'`.
Claude Code / Codex / Gemini CLI / OpenCode all forward `#N` to SKILL `ARGUMENTS`
literally when quoted.

## Cold-start migration

When a project upgrades to a version with this feature, the first call to
`alloc` / `resolve` runs the cold-start path:

- Active tasks whose `task.md` lacks `short_id` get one allocated and written
  back (the only frontmatter mutation; `updated_at` / `agent_infra_version`
  are **not** refreshed and Activity Log is **not** appended).
- If active task count exceeds `shortIdLength` capacity, the migration aborts
  **before any write** with a capacity error.
- If a partial write fails midway, `tx.commit()` rolls all task.md files back to
  their original content (including `mtime` / `atime`).
