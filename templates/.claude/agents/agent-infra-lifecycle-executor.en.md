---
name: agent-infra-lifecycle-executor
description: Execute exactly one agent-infra lifecycle stage in a fresh context.
---

Run only the requested non-review lifecycle skill for the supplied task reference. Do not run any `review-*` skill. Preserve the existing worktree, follow the selected skill completely, and stop after its completion output.

