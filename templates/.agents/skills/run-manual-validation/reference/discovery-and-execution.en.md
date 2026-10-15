# Automatic Discovery and Per-item Execution

Read this file before parsing input, discovering manual-validation items, or constructing validation actions.

## Input Modes

| Input | Handling |
|-------|----------|
| Non-empty target and command surround a literal `--` | Explicit mode; the command is authoritative for that target |
| A literal `--` is present but the target or command is empty | Invalid input; stop before `validation-run.started` |
| No `--` and only a task ref | Automatic mode |
| No `--` and additional positional arguments | Invalid or partial input; do not ignore arguments or guess a command |
| `--branch <ref>` is passed | Branch-only fallback; must also be explicit mode, so a missing command after `--` is invalid input |

Explicit mode still reads available sources to map coverage, but it must not synthesize another command for the same target. Only automatic mode constructs actions for discovered items.

Branch-only has no task ref, so both discovery sources are unreadable and are recorded as `unavailable`; this round's items are listed under the `explicit` source and must not trigger the automatic-mode source stop conditions.

## Work Gate Matrix

| mode | source state | gate |
|------|--------------|------|
| `explicit` | `any` | `continue` |
| `automatic` | `items` | `continue` |
| `automatic` | `empty` | `stop` |
| `automatic` | `unreadable-only` | `stop` |

The user command is effective work in valid explicit mode. Empty or unreadable sources affect only coverage mapping and reporting and must not cause an early stop. Automatic mode depends on reliable discovery results.

## Discovery Sources

1. Read manual-validation items from the latest `review-code` returned by `task-artifact`; this is the canonical local source. Read only that round's structured list, never task.md prose, older reviews, the activity log, or comment history.
2. Run `agent-infra-internal platform-pr inspect {task-id}` and read the bound PR body's pending manual-validation list from a successful response as the supplemental source.
3. Deduplicate semantically by target, required environment, and expected assertion. Merge identical items with review-code details taking precedence, append PR-only items, and classify material conflicts as `unresolved`.
4. Assign report-local IDs `MV-1..N` and record source, target, expected assertion, required capability, and candidate steps. Do not write the task ledger.

## PR Source Status

| PR inspect result | Local items exist | No local items |
|-------------------|-------------------|----------------|
| Success | Merge lists; use only local items if the PR list is empty | Use the PR list; stop before started when both lists are empty |
| `no-op` + `PR_NOT_LINKED` | Use local items only | Stop normally before started |
| `failed` or `blocked` | Continue with local items; record typed status, stable error code, and the source coverage gap | Fail closed before started and request a retry after platform access is restored |

Explicit mode may run its authoritative command when PR inspection fails, but the report must state that the PR list could not be reconciled. Never treat a read failure as an empty list or record the raw remote response.

## Classification and Safe Actions

Assign exactly one classification per item:

- `executable`: host capability is supported by sufficient evidence and the action is minimal, non-interactive, and scoped.
- `unavailable`: the required platform, filesystem semantics, permission, container, or account is definitely absent.
- `unknown`: only weak signals exist and a safe probe cannot prove capability.
- `unsafe`: validation would require destructive, secret-exposing, or unsanitizable actions.
- `unresolved`: sources materially conflict about the environment or expected assertion.

Only `executable` items may run. Commands must not expose credentials, environment variables, full argv, absolute user paths, or raw transcripts. Leave a coverage gap when safety cannot be established.

## Artifact Directory and Evidence Paths

Choose `{evidence-dir}` once per run. Write the report and every evidence JSON generated in that run to this directory:

- `task-bound`: use the `TaskDir` returned in the structured result of `task-context resolve`; never construct it from the task ID.
- `branch-only`: only after the user explicitly passes a valid `--branch` with valid explicit-mode input, create the directory once with Node built-ins: `fs.mkdtempSync(path.join(os.tmpdir(), "tmp-"))`. Use the existing Node runtime's `node:fs`, `node:os`, and `node:path`; do not add a script, helper, or storage layer. A task-resolution failure must not enter this branch.

Keep the report name returned by the core: `validation-run.md|validation-run-r{N}.md`. For task-bound evidence, remove `.md` from that report name to get `{artifact-stem}`, then name each file `{artifact-stem}-{MV-N}-{snapshot|inplace}.json`; different report rounds, targets, and scopes therefore do not overwrite each other. Branch-only writes `validation-run.md` in its new directory and uses `validation-run-{MV-N}-{snapshot|inplace}.json`. Generate paths with Node `path.join(evidence-dir, filename)` and pass the full path as one argument, correctly quoted for the current shell, to `--evidence-file`. Do not split paths containing spaces. Do not create a file for a scope that was not run.

Put evidence relative filenames in the report, never absolute user paths. The branch-only completion result separately gives `{evidence-dir}` as the retrieval path; the report and all JSON files are in that directory.

## Per-item Execution

1. Invoke each executable item separately:

   ```bash
   agent-infra-internal task-validate {task-ref|branch-ref} --scope snapshot --format json --evidence-file "{evidence-file}" -- {command...}
   ```

2. Only when the item or first-run evidence proves a dependency on uncommitted content, original mounts, or in-place permissions, explicitly invoke that item a second time with `--scope inplace`, use its separate scope evidence path, and record the reason.
3. One item failure does not stop independent remaining items. Record exit status, cleanup, and the sanitized JSON allowlist separately.
4. When the list is non-empty but no item is `executable`, still create and complete a validation-run artifact after started; do not run placeholder or fabricated commands.
5. Always stop before started for invalid input. In automatic mode, also stop before started without an artifact when both sources are reliably empty or the sole possible source is unreadable with no local items; those source-based stop conditions do not apply to valid explicit mode.
