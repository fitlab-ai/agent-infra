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

Preserve and present the complete non-empty stdout. Run prepare and inspect again only when the snapshot is not prepared. Reuse prepared or partially published facts. Unknown state is blocked.

```bash
agent-infra-internal release-workflow prepare {version} --entropy-report {path}
```

Present the prepare `status`, `error`, and `operations`, including milestone closure and creation of the next planning milestones. Stop on `failed` or `blocked`; do not request publish authorization. Continue only after a successful prepare and a fresh inspect.

Inspect again after prepare.

## 3. Present and Confirm

Present the complete latest snapshot JSON, including every channel state. Only an unambiguous affirmative reply for that snapshot in the current session authorizes publishing. A denial, adjustment, question, ambiguity, interruption, or changed snapshot stops the write and requires a new preview.

## 4. Publish and Reinspect

```bash
agent-infra-internal release-workflow publish {version}
```

Push refs normally, preserve partial success for replay, never force push, and inspect again after the operation. Explicitly list any incomplete GitHub Release, npm, Homebrew, or smoke state; a successful Git ref push is not a complete release.

## 5. Report Facts

After a complete publish, render the versioned next step without exposing internal actions or skipping directly to post-release:

```bash
agent-infra-internal agent-client next-steps \
  --skill create-release-note \
  --version {version}
```
