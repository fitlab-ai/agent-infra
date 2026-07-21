# Milestone Inference

Milestones narrow through declarative Issue intents:

```bash
# create/import phase
agent-infra-internal platform-issue sync {task-id} --agent {agent} --milestone initial

# code phase
agent-infra-internal platform-issue sync {task-id} --agent {agent} --milestone specific
```

`initial` prefers a valid task milestone, otherwise the lowest open `X.Y.x`, then `General Backlog`. `specific` narrows a release line to the highest open patch version using main/release-line ancestry. Missing facts or triage permission preserve the remote value and return skipped/degraded. `create-pr` reuses the Issue milestone in the 09/10 PR adapter.
