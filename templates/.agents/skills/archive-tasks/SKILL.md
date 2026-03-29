---
name: archive-tasks
description: "Archive completed tasks into a date-organized workspace directory"
---

# Archive Completed Tasks

Move completed tasks from `.agents/workspace/completed/` into `.agents/workspace/archive/YYYY/MM/DD/TASK-xxx/` and rebuild the archive index `manifest.md`.

## Execution Flow

### 1. Verify the environment

Confirm that `.agents/workspace/completed/` exists, then choose one of these four invocation modes:
- no arguments: archive every completed task
- `--days N`: keep the most recent `N` days and archive older tasks
- `--before YYYY-MM-DD`: archive only tasks completed before the given date
- `TASK-ID...`: archive only the selected tasks

### 2. Run the archive script

Execute:

```bash
bash .agents/skills/archive-tasks/scripts/archive-tasks.sh [--days N | --before YYYY-MM-DD | TASK-ID...]
```

The script is responsible for:
- reading `completed_at` from `task.md` frontmatter and falling back to `updated_at`
- moving task directories directly into `YYYY/MM/DD/TASK-xxx/` without compression
- skipping already archived, missing, or malformed tasks
- rebuilding `.agents/workspace/archive/manifest.md` from all archived tasks
- printing an archive and skip summary

### 3. Inform the user

Report:
- how many tasks were archived
- how many tasks were skipped and why
- the path to `manifest.md`
