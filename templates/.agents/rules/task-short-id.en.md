# Task short id

Task short ids let mobile-style SKILL invocations replace the full 22-char
`TASK-YYYYMMDD-HHMMSS` with bare numeric `N` while a task is active.

## Syntax

- Only **bare numeric `N`** is accepted (no shell quoting needed): e.g. `1`, `7`, `42`.
- Resolution: drop leading zeros and take the numeric value `n`; if `n == 0`,
  reject (reserved); if `n > 10^shortIdLength - 1`, reject (over capacity);
  otherwise canonicalize to `${n.padStart(shortIdLength, '0')}` as the
  registry key.
- With the default `shortIdLength=2`, capacity is `n ∈ [1, 99]`; registry keys
  look like `01`, `07`, `42`.
- `00` (or `0` when `shortIdLength=1`) is reserved and never allocated; digits
  only, no letters.
- The plain `TASK-…` form keeps working everywhere; bare numeric is an alias,
  not the persisted task id.
- Removed `#N` / `#NN` syntax is consistently rejected as an invalid task ref.

## Lifecycle

| Action     | When                                                                 | Effect on registry                                            |
|------------|-----------------------------------------------------------------------|---------------------------------------------------------------|
| alloc      | `create-task`, `import-issue`, `import-codescan`, `import-dependabot` | Assigns lowest free `NN` in the registry.                    |
| resolve    | Lifecycle SKILLs (`analyze-task`, `plan-task`, `code-task`, …)        | Looks up `NN` → full task id. Does not allocate.             |
| release    | Successful sandbox cleanup; also `cancel-task`, `block-task`, `close-codescan`, and `close-dependabot` | Removes the registry entry. |
| re-alloc   | `restore-task`                                                        | Re-allocates a (possibly new) `NN` in the registry. |

Completion retains the short id so a sandbox still associated with the
completed task can resolve it before cleanup. The id is released only after
managed sandbox cleanup confirms that the container was deleted successfully.
Other lifecycle intents release ids at the times listed in the table.

## Configuration

```jsonc
// .agents/.airc.json
{
  "task": {
    "shortIdLength": 2  // default; capacity = 99 (01–99). Set to 3 for 001–999.
  }
}
```

When all slots for the configured width are in use, `alloc` fails with a clear
error suggesting either archiving some tasks or raising `task.shortIdLength`.
There is no silent extension or truncation. Changing `shortIdLength` requires
archiving all active tasks first (the registry key width depends on it).

## Short-id resolution scope (split by entrypoint)

| Entrypoint                                                  | Hit                  | Miss                                                 |
|-------------------------------------------------------------|----------------------|------------------------------------------------------|
| SKILL parameter resolver (lifecycle SKILLs)                  | resolve to full id   | **strict error** — short id not found / invalid     |
| `ai sandbox exec <N>` / `ai sandbox create <N>`           | resolve to an active task id, then read `branch` from task.md | **strict error** — no ls-index fallback, no literal-branch fallback; hint the user to pass a short id / `TASK-id` / branch name |
| `ai sandbox rm <N>`                                       | resolve the retained mapping, then read active or completed identity by full task id | **strict error** — stop cleanup when the short id is missing |

`list --verify` is strictly read-only: every active task must have a mapping;
registry mappings may point to a valid active task or to a
`completed/{taskId}/task.md` whose identity matches and whose status is
`completed`. Other mappings are reported as orphans; no state is modified.

## SKILL parameter resolver

Any SKILL (alloc / resolve / release / re-alloc lifecycle entry-points) that
receives a `{task-id}` argument must follow this contract:

1. If `{task-id}` matches `^[0-9]+$` (bare numeric `N`):

```bash
if [[ "{task-id}" =~ ^[0-9]+$ ]]; then
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

Short ids are pure local state, persisted only in the registry
`.agents/workspace/active/.short-ids.json`; task.md does not hold the short id:

- Path: `<repo-root>/.agents/workspace/active/.short-ids.json`
- Schema: `{ "version": 1, "ids": { "01": "TASK-20260609-192644", "02": "TASK-…" } }`
- Keys are zero-padded decimal strings of `task.shortIdLength` digits; values are
  full `TASK-…` task ids.
- Automatically git-ignored (the whole active workspace is ignored; no new
  ignore entry needed).
- Created on demand by the first `alloc`; an absent file is treated as an empty
  registry.
- Short ids are assigned only by an explicit `alloc` (`create-task` /
  `import-*` / `restore-task`); `resolve` and `list` are read-only and do not
  perform implicit cleanup.
- `alloc` may clean up stale entries that point neither to an active task nor
  to valid completed task content. Completed mappings stay until managed
  sandbox cleanup succeeds.
- Task operations may resolve a completed mapping and then reject it at their
  own state gate; `ai sandbox create <N>` still accepts active tasks only.

`resolve(<N>)` workflow: ① validate arg matches `^[0-9]+$` →
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
- **Reserved key**: the resolved `n == 0` (inputs like `0`, `00`). Exit code 1.
- **Over capacity**: the resolved `n > 10^shortIdLength - 1` (e.g. `100` or
  `100` when `shortIdLength=2`). Exit code 1.
- **Parameter format error**: input matches neither `^[0-9]+$` nor a
  `TASK-id` (e.g. `#1`, `#abc`, `#`, `5.5`). Exit code 1.

## Cross-TUI use

Bare numeric `N` is safe in every shell and TUI without quoting:
`ai sandbox exec 11 'npm test'`, `/review-analysis --task 11`.
