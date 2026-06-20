# Rules Index

`.agents/rules/` holds every collaboration rule in this project. Each SKILL loads the
relevant few on demand; this index groups all rules by domain with a one-line purpose,
so you can quickly find "which ones to read" without opening each file.

> Maintenance note: when adding or removing `.agents/rules/*.md`, update this index too.

## General Principles

- [`no-mid-flow-questions.md`](no-mid-flow-questions.md) — Silence during SKILL runs: no user questions by default, plus the exceptions the rule lists.
- [`next-step-output.md`](next-step-output.md) — "Next step" output rules: task short-id rendering and the `Completed at` trailer.
- [`version-stamp.md`](version-stamp.md) — How and when to stamp `agent_infra_version`.
- [`debugging-guide.md`](debugging-guide.md) — Structured debugging flow: gather evidence → form hypothesis → verify hypothesis → fix the root cause; no blind patch-and-retry.

## Issue / PR

- [`issue-pr-commands.md`](issue-pr-commands.md) — GitHub commands to verify auth and read/write Issues / PRs.
- [`pr-checks-commands.md`](pr-checks-commands.md) — Commands to watch PR required checks and pull failure logs (`watch-pr`).
- [`create-issue.md`](create-issue.md) — Cascading Issue creation after `create-task` writes `task.md`.
- [`issue-sync.md`](issue-sync.md) — Sync markers and flow for task artifacts ↔ Issue comments / labels / fields.
- [`issue-fields.md`](issue-fields.md) — Read/write flow for Issue Type pinned fields (Priority/Effort/dates).
- [`pr-sync.md`](pr-sync.md) — Sync rule for the single reviewer-facing PR summary comment.

## Task Workflow

- [`task-management.md`](task-management.md) — Task intent detection and workflow-command mapping.
- [`review-handshake.md`](review-handshake.md) — Three-stage bidirectional review handshake: four-state disposition, symmetric evidence, disagreement ledger, convergence and post-review commit gate.
- [`task-short-id.md`](task-short-id.md) — Resolution, allocation and lifecycle of `#NN` / bare-number short ids.
- [`milestone-inference.md`](milestone-inference.md) — Milestone inference for create-task / code-task / create-pr.
- [`label-milestone-setup.md`](label-milestone-setup.md) — Platform commands to initialize labels / milestones.
- [`security-alerts.md`](security-alerts.md) — Commands to import / close Dependabot and Code Scanning alerts.

## Commit & Release

- [`commit-and-pr.md`](commit-and-pr.md) — Conventional Commits message and PR conventions.
- [`release-commands.md`](release-commands.md) — Read past releases, query merged PRs, publish release notes.

## Testing & Cross-platform

- [`testing-discipline.md`](testing-discipline.md) — Test-writing discipline: prefer structural asserts, no brittle wording matches.
- [`cross-platform-tests.md`](cross-platform-tests.md) — Cross-platform test guards: express platform skips via `onPlatforms()`.

## CLI

- [`cli-help-format.md`](cli-help-format.md) — CLI help text conventions: unify display name on `ai`, `Usage:`+`Commands:` structure, alphabetical command order (top-level and namespace-level help only).
