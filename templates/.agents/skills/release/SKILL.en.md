---
name: release
description: >
  Run the version release workflow.
  Use when preparing and publishing a version. Parameter: X.Y.Z.
---

# Release

Release state is derived from external facts and prepare/publish require separate authorization.

## 1. Validate Input and Entropy Report

Confirm SemVer and the human release checkpoint.

## 2. Inspect Facts

```bash
agent-infra-internal release-workflow inspect {version}
```

## 3. Prepare

```bash
agent-infra-internal release-workflow prepare {version} --entropy-report {path}
```

Stop after prepare; never publish implicitly.

## 4. Publish Separately

Only after explicit user authorization:

```bash
agent-infra-internal release-workflow publish {version}
```

Push refs normally, preserve partial success for replay, and never force push.

## 5. Report Facts

Show the snapshot and render next-step client commands through the shared helper. Treat unknown external state as blocked.
