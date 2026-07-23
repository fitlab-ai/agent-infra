---
name: post-release
description: >
  Run post-release processing.
  Use after a version has been published and needs finalization.
---

# Post-release

## 1. Inspect Channel Facts

```bash
agent-infra-internal release-workflow inspect {version}
```

Pending or unknown is blocked; a definite failure is failed.

## 2. Run Post-release

```bash
agent-infra-internal release-workflow post {version}
```

The core owns build, next development version, inline artifacts, explicit-path commit, normal push, and post-write inspection.

## 3. Report the Snapshot

Report channel, smoke, commit, and push facts without presenting degraded or blocked as complete.
