---
name: post-release
description: >
  Run post-release processing.
  Use after a version has been published and needs finalization.
---

# Post-release

Require one explicit canonical SemVer `{version}`. Do not fall back to the latest tag.

## 1. Inspect Channel Facts

```bash
agent-infra-internal release-workflow inspect {version}
```

Pending or unknown is blocked; a definite failure is failed. Report `complete` directly from external facts.

## 2. Prepare Local Post-release Work

When incomplete, run:

```bash
agent-infra-internal release-workflow post-prepare {version}
agent-infra-internal release-workflow inspect {version}
```

The core owns build, the optional demo, next development version, inline artifacts, and the explicit-path post commit. This action must not push. Replays recover from Git and channel facts without repeating completed work.

## 3. Check the Confirmation Snapshot

- `complete`: report completion without asking or publishing.
- `postConfirmation` present: display every field and its `sha256`, then continue to step 4.
- `postConfirmation` absent: report diagnostics such as `isHead=false` or a dirty worktree/index and stop without asking or publishing.

## 4. Authorize the Current Snapshot

Only after displaying the complete `postConfirmation` in the current session, ask once whether to publish. Continue only for an unambiguous affirmative answer. Denial, adjustment, a question, ambiguity, or interruption stops. Authorization never carries across sessions or snapshots.

## 5. Publish the Confirmed Snapshot

```bash
agent-infra-internal release-workflow post-publish {version} \
  --expected-sha256 "{post-confirmation-sha256}"
```

The core re-inspects and verifies the digest before one normal branch push; force pushes are forbidden. On snapshot drift, stop and return to step 1 for a new display and authorization.

## 6. Re-inspect and Report

```bash
agent-infra-internal release-workflow inspect {version}
```

Report all channel, released/new version, smoke, post commit, and remote branch facts. Describe completion only for phase `complete`; never present failed, degraded, or blocked as success.
