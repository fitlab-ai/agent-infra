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
- [`compatibility-policy.md`](compatibility-policy.md) — Compatibility by exception: admission evidence, implementation boundaries, exit conditions, and lifecycle review requirements.
- [`evidence-reporting.md`](evidence-reporting.md) — Minimum evidence semantics for state checks, successful summaries, exceptional results, identity fields, and sensitive data boundaries.
- [`sync-content-generation.md`](sync-content-generation.md) — Producer-side Markdown constraints for task and lifecycle content synchronized to Issues.
- [`decision-qualification.md`](decision-qualification.md) — Constraint, candidate, human-confirmation, and six-artifact qualification-audit contract.

## Issue / PR

- [`issue-pr-commands.md`](issue-pr-commands.md) — PR commands and Issue intent entry points.
- [`pr-checks-commands.md`](pr-checks-commands.md) — Commands to watch all PR checks and pull failure logs (`watch-pr`).
- [`create-issue.md`](create-issue.md) — Declarative Issue creation after `create-task` writes `task.md`.
- [`issue-sync.md`](issue-sync.md) — Issue comment markers and declarative metadata intent contract.
- [`issue-fields.md`](issue-fields.md) — Dynamic Issue Type pinned-field mapping boundary.
- [`pr-sync.md`](pr-sync.md) — Sync rule for the single reviewer-facing PR summary comment.

## Task Workflow

- [`task-management.md`](task-management.md) — Task intent detection and workflow-command mapping.
- [`lifecycle-orchestration.md`](lifecycle-orchestration.md) — Fresh executor/reviewer, one-use receipt, pause/recovery, and safe endpoint rules for `run-task`.
- [`review-handshake.md`](review-handshake.md) — Three-stage bidirectional review handshake: four-state disposition, symmetric evidence, disagreement ledger, convergence and post-review commit gate.
- [`review-method.md`](review-method.md) — Shared three-stage review method: multi-pass review, risk lenses, traceability, and finding evidence.
- [`local-artifact-repair.md`](local-artifact-repair.md) — Pre-completion local artifact validation for analysis/plan/code and model-per-case repair, safety gates, and convergence for failed review artifacts.
- [`human-decision-context.md`](human-decision-context.md) — Self-contained context and canonical structure for new human-decision details.
- [`task-short-id.md`](task-short-id.md) — Resolution, allocation and lifecycle of bare-number short ids.
- [`milestone-inference.md`](milestone-inference.md) — Milestone inference for create-task / code-task / create-pr.
- [`label-milestone-setup.md`](label-milestone-setup.md) — Shared entry points to initialize labels / milestones.
- [`security-alerts.md`](security-alerts.md) — Shared entry point to import / close dependency and code-scanning alerts.

## Commit & Release

- [`commit-and-pr.md`](commit-and-pr.md) — Conventional Commits message and PR conventions.
- [`release-commands.md`](release-commands.md) — Read past releases, query merged PRs, publish release notes.

## Testing

- [`testing-discipline.md`](testing-discipline.md) — Test-writing discipline: prefer structural asserts, no brittle wording matches.

## CLI

- [`cli-help-format.md`](cli-help-format.md) — CLI help text conventions: unify display name on `ai`, `Usage:`+`Commands:` structure, alphabetical command order (top-level and namespace-level help only).
