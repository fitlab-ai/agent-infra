# Task short id

Task short ids let mobile-style SKILL invocations replace the full 22-char
`TASK-YYYYMMDD-HHMMSS` with bare numeric `N` (recommended) or `#NN` while a
task is active.

## Syntax

- Two equivalent literal forms are accepted:
  - **Bare numeric `N`** (recommended; no shell quoting needed): e.g. `1`, `7`, `42`.
  - **`#`-prefixed `#N` / `#NN`** (also accepted; bash needs `'...'` quoting): e.g. `#1`, `#01`, `#42`.
- Resolution: drop leading zeros and take the numeric value `n`; if `n == 0`,
  reject (reserved); if `n > 10^shortIdLength - 1`, reject (over capacity);
  otherwise canonicalize to `#${n.padStart(shortIdLength, '0')}` as the
  registry key.
- With the default `shortIdLength=2`, capacity is `n ∈ [1, 99]`; registry keys
  look like `01`, `07`, `42`.
- `#00` (or `#0` when `shortIdLength=1`) is reserved and never allocated; digits
  only, no letters.
- The plain `TASK-…` form keeps working everywhere; bare numeric / `#NN` is an
  alias, not the persisted task id.

## Lifecycle

| Action     | When                                                                 | Effect on registry & task.md                                  |
|------------|-----------------------------------------------------------------------|---------------------------------------------------------------|
| alloc      | `create-task`, `import-issue`, `import-codescan`, `import-dependabot` | Assigns lowest free `#NN`; writes `short_id` into task.md.    |
| resolve    | Lifecycle SKILLs (`analyze-task`, `plan-task`, `code-task`, …)        | Looks up `#NN` → full task id. Does not allocate.             |
| release    | `complete-task`, `cancel-task`, `block-task`, `close-codescan`, `close-dependabot` | Removes the registry entry; leaves task.md `short_id` as a historical value. |
| re-alloc   | `restore-task`                                                        | Re-allocates a (possibly new) `#NN` and writes it to task.md. |

Short ids are valid only while a task lives in `.agents/workspace/active/`.
Once it is moved to `completed/`, `blocked/`, or `archive/`, the `#NN` slot is
freed and may be reused by a new task.

## Configuration

```jsonc
// .agents/.airc.json
{
  "task": {
    "shortIdLength": 2  // default; capacity = 99 (#01–#99). Set to 3 for #001–#999.
  }
}
```

When all slots for the configured width are in use, `alloc` fails with a clear
error suggesting either archiving some tasks or raising `task.shortIdLength`.
There is no silent extension or truncation. Changing `shortIdLength` requires
archiving all active tasks first (the registry key width depends on it).

## `#NN` resolution scope (split by entrypoint)

| Entrypoint                                                  | Hit                  | Miss                                                 |
|-------------------------------------------------------------|----------------------|------------------------------------------------------|
| SKILL parameter resolver (lifecycle SKILLs)                  | resolve to full id   | **strict error** — short id not found / invalid     |
| `ai sandbox exec <N \| '#N'>` / `ai sandbox create <N \| '#N'>`           | resolve to full id, then read `branch` from task.md | **strict error** — no ls-index fallback, no literal-branch fallback; hint the user to pass a short id / `TASK-id` / branch name |

`list --verify` is strictly read-only: it reports discrepancies between active
dir, registry, and `short_id` declared in each `task.md`, but never writes.

## SKILL parameter resolver

Any SKILL (alloc / resolve / release / re-alloc lifecycle entry-points) that
receives a `{task-id}` argument must follow this contract:

1. If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric `N` or `#`-prefixed `#N`):

```bash
if [[ "{task-id}" =~ ^[#]?[0-9]+$ ]]; then
  # The script writes the full error message (covering reserved / exceeds
  # shortIdLength capacity / malformed input) to stderr; callers only forward
  # the exit.
  task_id=$(node .agents/scripts/task-short-id.js resolve "{task-id}") || exit 1
else
  task_id="{task-id}"
fi
```

2. Every downstream command treats `{task-id}` as `$task_id` (already the full
   `TASK-YYYYMMDD-HHMMSS` form).
3. Error-code semantics for resolve are documented under "Error scenarios"; do
   not reimplement error handling inside each SKILL.

## Storage

The short id system persists state in two places that stay in sync at rest:

| Location | Written by | Read by | Removed by |
|---|---|---|---|
| `.agents/workspace/active/.short-ids.json` (registry) | `alloc` / cold-start migration | `resolve` (authoritative) / `list` / `list --verify` | `release` / cold-start stale cleanup |
| `short_id` frontmatter field in each task.md | `alloc` / cold-start migration | `list --verify` (consistency check) | **never** (kept as historical value after archive) |

**Registry**:

- Path: `<repo-root>/.agents/workspace/active/.short-ids.json`
- Schema: `{ "version": 1, "ids": { "01": "TASK-20260609-192644", "02": "TASK-…" } }`
- Keys are zero-padded decimal strings of `task.shortIdLength` digits; values are
  full `TASK-…` task ids.
- Automatically git-ignored (the whole active workspace is ignored; no new
  ignore entry needed).
- Created on demand by the first `alloc` / `resolve`; an absent file is treated
  as an empty registry.

**`short_id` field in task.md**:

- Lives in frontmatter, immediately after `id`; formatted `short_id: #01`.
- Matches the registry key byte-for-byte (including the `#` prefix).
- After archive (complete-task / cancel-task / block-task / close-*) the
  registry entry is deleted immediately (the short id can be reused), but the
  `short_id` field in task.md is kept as a historical value. The resolver
  trusts the registry only.
- Cold-start migration: the first `alloc` / `resolve` after an upgrade scans
  the active directory and fills in the missing field for legacy tasks; the
  field write is constrained (does NOT refresh `updated_at` /
  `agent_infra_version` and does NOT append Activity Log).

`resolve(<N|'#N'>)` workflow: ① validate arg matches `^[#]?[0-9]+$` →
② strip leading zeros and take the numeric value `n`; classify as reserved
(`n == 0`) / over capacity (`n > 10^shortIdLength - 1`) / normal → ③ on
normal, use `n.padStart(shortIdLength, '0')` as the registry `ids` key
→ ④ return full task id on hit; on miss, exit 1 with the `list --verify`
repair hint.

## Error scenarios

- **Short id not found**: the registry has no entry for the resolved key.
  Either the task was archived (release freed the slot) or the input is
  wrong. Exit code 1.
- **Registry corruption** (duplicate registry entries for the same task id, or
  the JSON is unparsable): exit code 2; manual cleanup required.
- **Reserved key**: the resolved `n == 0` (inputs like `0`, `#0`, `#00`). Exit code 1.
- **Over capacity**: the resolved `n > 10^shortIdLength - 1` (e.g. `100` or
  `#100` when `shortIdLength=2`). Exit code 1.
- **Parameter format error**: input matches neither `^[#]?[0-9]+$` nor a
  `TASK-id` (e.g. `#abc`, `#`, `5.5`). Exit code 1.

## Cross-TUI quoting

Bare numeric `N` is safe in every shell and TUI without quoting (recommended):
`ai sandbox exec 11 'npm test'`, `/review-analysis 11`.

The `#N` / `#NN` form is also accepted; but bash treats `#` as a comment
marker, so it must be single-quoted: `ai sandbox exec '#03' 'npm test'`.
Claude Code / Codex / Gemini CLI / OpenCode all forward `#NN` to SKILL
`ARGUMENTS` literally when quoted.

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
