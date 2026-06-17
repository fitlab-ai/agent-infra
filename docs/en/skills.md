# Built-in AI Skills

[← Back to README](../../README.md) · [中文](../zh-CN/skills.md)

agent-infra ships with **a rich set of built-in AI skills**. They are organized by use case, but they all share the same design goal: every AI TUI should be able to execute the same workflow vocabulary in the same repository.

## What each skill does behind the scenes

These are not thin command aliases. Each skill encapsulates standardized processes that are tedious and error-prone when done by hand:

- **Structured artifacts** — every step produces a templated document (`analysis.md`, `review-analysis.md`, `plan.md`, `review-plan.md`, `code.md`, `review-code.md`) with consistent structure, not free-form notes
- **Multi-round versioning** — requirements changed? Run `analyze-task` again to get `analysis-r2.md`; the full revision history is preserved
- **Severity-classified reviews** — `review-code` categorizes findings into Blocker / Major / Minor with file paths and fix suggestions, not a vague "looks good"
- **Cross-tool state continuity** — `task.md` records who did what and when; Claude can analyze, Codex can implement, Gemini can review — context transfers seamlessly
- **Audit trail and co-authorship** — every step appends to the Activity Log; the final commit includes `Co-Authored-By` lines for all participating AI agents

## Task Lifecycle

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `create-task` | Create a task scaffold from a natural-language request and cascade Issue creation through the platform rule when available. | `description` | Start a new feature, bug-fix, or improvement from scratch. |
| `import-issue` | Import a GitHub Issue into the local task workspace. | `issue-number` | Convert an existing Issue into an actionable task folder. |
| `analyze-task` | Produce a requirement analysis artifact for an existing task. | `task-id` | Capture scope, risks, and impacted files before designing. |
| `review-analysis` | Review the requirement analysis and classify findings by severity. | `task-id` | Confirm the analysis is complete before design. |
| `plan-task` | Write the technical plan with a review checkpoint. | `task-id` | Define the approach after analysis approval. |
| `review-plan` | Review the technical plan and classify findings by severity. | `task-id` | Confirm the design is actionable before coding. |
| `code-task` | Implement the approved plan or fix code review findings, producing a code report. | `task-id` | Write code, tests, and docs after plan approval, or handle review feedback. |
| `review-code` | Review the code and classify findings by severity. | `task-id` | Run a structured code review before merging. |
| `complete-task` | Mark the task complete and archive it after all gates pass. | `task-id` | Close out a task after review, tests, and commit are done. |

## Task Status

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `check-task` | Inspect the current task status, workflow progress, and next step. | `task-id` | Check progress without modifying task state. |
| `block-task` | Move a task to blocked state and record the blocker reason. | `task-id`, `reason` (optional) | Pause work when an external dependency or decision is missing. |
| `restore-task` | Restore local task files from GitHub Issue sync comments. | `issue-number`, `task-id` (optional) | Recover a task workspace after switching machines or clearing local state. |

## Issue and PR

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `create-pr` | Open a Pull Request to an inferred or explicit target branch. | `task-id` (optional), `target-branch` (optional) | Publish reviewed changes for merge, with optional explicit task linkage after a fresh session. |
| `watch-pr` | Watch a PR's required checks and self-heal failures until green. | `task-id` or `--pr <number>` (optional; defaults to the current branch's PR) | Monitor CI after create-pr and auto-fix simple failures before merging. |

## Code Quality

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `commit` | Create a Git commit with task updates and copyright-year checks. | None | Finalize a coherent change set after tests pass. |
| `test` | Run the standard project validation flow. | None | Validate compile checks and unit tests after a change. |
| `test-integration` | Run integration or end-to-end validation. | None | Verify cross-module or workflow-level behavior. |

## Release

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `release` | Execute the version release workflow. | `version` (`X.Y.Z`) | Publish a new project release. |
| `create-release-note` | Generate release notes from PRs and commits. | `version`, `previous-version` (optional) | Prepare a changelog before shipping. |
| `post-release` | Run post-release follow-up tasks (version bump, artifact rebuild, optional demo capture). | None | Finalize the release cycle after pushing a release tag. |

## Security

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `import-dependabot` | Import a Dependabot alert and create a remediation task. | `alert-number` | Convert a dependency security alert into a tracked fix. |
| `close-dependabot` | Close a Dependabot alert with a documented rationale. | `alert-number` | Record why an alert does not require action. |
| `import-codescan` | Import a Code Scanning alert and create a remediation task. | `alert-number` | Triage CodeQL findings through the normal task workflow. |
| `close-codescan` | Close a Code Scanning alert with a documented rationale. | `alert-number` | Record why a scanning alert can be safely dismissed. |

## Project Maintenance

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `upgrade-dependency` | Upgrade a dependency from one version to another and verify it. | `package`, `old-version`, `new-version` | Perform controlled dependency maintenance. |
| `refine-title` | Rewrite an Issue or PR title into Conventional Commits format. | `number` | Normalize inconsistent GitHub titles. |
| `init-labels` | Initialize the repository's standard GitHub label set. | None | Bootstrap labels in a new repository. |
| `init-milestones` | Initialize the repository's milestone structure. | None | Bootstrap milestone tracking in a new repository. |
| `archive-tasks` | Archive completed tasks into a date-organized directory with a manifest index. | `[--days N \| --before DATE \| TASK-ID...]` | Periodically clean up the `completed/` directory. |
| `update-agent-infra` | Update the project's collaboration infrastructure to the latest template version. | None | Refresh shared AI tooling without rebuilding local conventions. |

> Every skill works across supported AI TUIs. The command prefix changes, but the workflow semantics stay the same.
