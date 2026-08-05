---
name: release
description: >
  Run the version release workflow.
  Use when preparing and publishing a version. Parameter: X.Y.Z.
---

# Release

Prepare, present the latest fact snapshot, and request one remote-publish authorization in a single invocation. External facts remain the source of truth.

## 1. Validate Input and Entropy Checkpoint

Require one canonical SemVer `{version}` and a satisfied entropy checkpoint.

## 2. Prepare and Inspect Facts

```bash
agent-infra-internal release-workflow inspect {version}
```

Run prepare and inspect again only when the snapshot is not prepared. Reuse prepared or partially published facts. Unknown state is blocked.

```bash
agent-infra-internal release-workflow prepare {version} --entropy-report {path}
```

## 3. Present and Confirm

Present the latest snapshot. Only an unambiguous affirmative reply for that snapshot in the current session authorizes publishing. A denial, adjustment, question, ambiguity, interruption, or changed snapshot stops the write and requires a new preview.

## 4. Publish and Reinspect

```bash
agent-infra-internal release-workflow publish {version}
```

Push refs normally, preserve partial success for replay, never force push, and inspect again after the operation.

## 5. Report Facts

After a complete publish, render the versioned next step without exposing internal actions or skipping directly to post-release:

```bash
agent-infra-internal agent-client next-steps \
  --skill create-release-note \
  --version {version}
```
