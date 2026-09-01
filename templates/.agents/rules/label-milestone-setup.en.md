# Label and Milestone Setup

Read this rule before initializing labels or milestones, or before changing milestone metadata during release work.

## Entry points

Use the shared scripts rather than composing provider commands in a skill:

```text
bash .agents/skills/init-labels/scripts/init-labels.sh [--cleanup-stale-in]
bash .agents/skills/init-milestones/scripts/init-milestones.sh "$ARGUMENTS"
```

`init-labels.sh` reads the repository's `labels.in` configuration, creates or updates the declared `in:` labels, and preserves unrelated labels. `--cleanup-stale-in` is destructive and may only be passed after explicit confirmation; it removes stale `in:` labels that are no longer declared.

`init-milestones.sh` owns milestone inference and the provider-specific write path. Callers must pass the requested arguments through unchanged and must not rebuild milestone discovery, ordering, branch ancestry, or write logic.

Both scripts return a stable status. A successful no-op is still success; a degraded result must be reported without claiming that remote metadata was changed. Failed or cancelled operations must not be reported as completed.
