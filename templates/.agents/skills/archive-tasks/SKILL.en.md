---
name: archive-tasks
description: >
  Archive completed tasks into a date-organized workspace directory.
  Use when completed tasks have accumulated and you want to tidy them into the date-organized archive.
---

# Archive Completed Tasks

Archive completed tasks from `.agents/workspace/completed/` into `.agents/workspace/archive/YYYY/MM/DD/TASK-xxx/local/` and rebuild a three-level archive index. Local task materials live in `local/` with a path-sorted `contents.sha256`; the TASK root contains no ordinary files.
- root manifest: `.agents/workspace/archive/manifest.md`
- yearly manifest: `.agents/workspace/archive/YYYY/manifest.md`
- monthly manifest: `.agents/workspace/archive/YYYY/MM/manifest.md`

## Execution Flow

### 1. Migrate an existing archive (only when the old layout exists)

Run the one-time migration during a maintenance window. It creates and verifies a full archive backup under `.agents/workspace/archive-backups/` before changing the archive. After interruption, archive operations fail closed; restore with the backup named by the migration marker.

```bash
node .agents/skills/archive-tasks/scripts/migrate-archive.mjs
node .agents/skills/archive-tasks/scripts/migrate-archive.mjs --restore .agents/workspace/archive-backups/archive-before-l0-<UTC>.tar
```

### 2. Verify the environment

Confirm that `.agents/workspace/completed/` exists, then choose one of these four invocation modes:
- no arguments: archive every completed task
- `--days N`: keep the most recent `N` days and archive older tasks
- `--before YYYY-MM-DD`: archive only tasks completed before the given date
- `TASK-ID...`: archive only the selected tasks

### 3. Run the archive script

Execute:

```bash
bash .agents/skills/archive-tasks/scripts/archive-tasks.sh [--days N | --before YYYY-MM-DD | TASK-ID...]
```

The script is responsible for:
- reading `completed_at` from `task.md` frontmatter and falling back to `updated_at`
- storing local task materials under `YYYY/MM/DD/TASK-xxx/local/` without compression
- skipping already archived, missing, or malformed tasks
- rebuilding root, yearly, and monthly manifests from all archived tasks
- printing an archive and skip summary

### 4. Inform the user

Report:
- how many tasks were archived
- how many tasks were skipped and why
- the path to the root manifest
