# Label and Milestone Setup

Read this rule before initializing labels or milestones, or before changing milestone metadata during release work.

## Runtime intent entry points

Use the internal runtime intents rather than composing platform commands in a skill:

```text
agent-infra-internal platform-metadata init-labels [--cleanup-stale-in]
agent-infra-internal platform-metadata init-milestones [--history]
```

The `init-labels` runtime intent reads the repository's `labels.in` configuration, creates or updates the declared `in:` labels, and preserves unrelated labels. `--cleanup-stale-in` is destructive and may only be passed after explicit confirmation; it removes stale `in:` labels that are no longer declared.

The `init-milestones` runtime intent owns milestone planning and result reporting. Callers must pass the requested arguments through unchanged and must not rebuild milestone discovery, ordering, or write logic.

Both intents return a stable status. A successful no-op is still success; a degraded result must be reported without claiming that remote metadata was changed. Failed or cancelled operations must not be reported as completed.
