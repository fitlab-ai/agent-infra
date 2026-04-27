# Issue Sync

## Marker Registry

These hidden markers are the canonical registry for Issue synchronization:

| Key | Marker |
|---|---|
| `task` | `<!-- sync-issue:{task-id}:task -->` |
| `artifact` | `<!-- sync-issue:{task-id}:{artifact-stem} -->` |
| `artifactChunk` | `<!-- sync-issue:{task-id}:{artifact-stem}:{part}/{total} -->` |
| `summary` | `<!-- sync-issue:{task-id}:summary -->` |
| `cancel` | `<!-- sync-issue:{task-id}:cancel -->` |

Callers should refer to the marker key in skill prose and keep concrete marker strings in this rule or the platform adapter defaults.

This code platform does not provide built-in issue synchronization.

Issue metadata, labels, milestones, assignees, and comments are skipped for custom platforms unless you provide matching `.{platform}.en.md` rule templates and platform adapters. Continue writing local task artifacts normally.
