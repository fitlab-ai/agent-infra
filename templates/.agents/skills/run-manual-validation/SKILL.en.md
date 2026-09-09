---
name: run-manual-validation
description: >
  Safely run task manual validation on the host and record standard evidence.
  Use when validation needs host credentials, a real container, or in-place worktree state.
  Only invoke automatically when the conversation includes a resolvable task reference.
---

# Run Manual Validation

Lifecycle events require explicit trigger data: use `{trigger-initiator}=orchestrator` for orchestration and `model` otherwise; `{request-id}` is a stable single-line identifier for this task and artifact round, and `{reason-code}` is `user-request` or `validation-rerun`. Reuse the same values for started and completed.

## Task Context Resolution

The entry point may omit the task ref; explicit task scope accepts only `--task <ref>` or `-t <ref>`, and positional task refs are not interpreted. Parse `--scope`, `--timeout`, and `--format` before `--`, preserve the user command after `--` verbatim, then call `agent-infra-internal task-context resolve {task-scope}`. Pass through resolution failures without scanning tasks locally. The internal `task-validate` protocol continues to use a positional task ref.

For cross-environment validation (the task workspace lives on another host), pass `--branch <ref>` explicitly to enter the branch-only fallback: skip `task-context resolve` and use that branch ref directly as the positional argument of `task-validate`, which returns branch-only evidence with `taskId: null`. Without `--branch`, a resolution failure is still passed through; never degrade silently. `--task` and `--branch` are mutually exclusive.

## Boundary

### Persisted Report Evidence

Before generating a validation report, read `.agents/rules/evidence-reporting.md`. Record only the command name, target scope, exit status, sanitized result, and coverage gap; never record complete argv, environment variables, tokens, absolute paths, or a raw sensitive transcript.

- Select the validation mode, call the sole mechanical entry point, and record evidence; do not mark PR manual validation complete.
- `complete-manual-validation` remains the maintainer's final registration after coverage is judged sufficient.
- Never manipulate temporary worktrees, leases, or containers directly; only call `agent-infra-internal task-validate`.
- Never record tokens, environment variables, full argv, absolute user paths, or raw transcripts in the artifact.
- Before generating a validation artifact Markdown file that will be synced to an Issue, read `.agents/rules/sync-content-generation.md` and follow its generator-side constraints; Issue sync remains transparent and does not parse or rewrite the body.
- The branch-only fallback writes to `.agents/workspace/validations/{branch-slug}/` and is marked `recoverable: false`: no task.md write-back, no lifecycle events, no Issue sync, no `task-verify`; the artifact must be carried back to the host that owns the task workspace for registration.

## Step 0: State Check (pre-execution hard gate)

Resolve the task reference, then run this command and record the task/artifact scope, key result, and uncovered parts in the artifact; do not paste complete directory listings or task tails on normal success. Retain decisive raw lines only for failures, blocking conditions, identity mismatches, or disputes:

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

Branch-only has no `{task-id}`: skip this step and record `not-applicable (branch-only)` in the artifact's `## State Check` section.

## Steps

1. Read `reference/discovery-and-execution.md` and parse the input mode. Stop before started without an artifact for invalid or partial input.
2. Run `agent-infra-internal task-artifact {task-id} inspect --family validation-run` and read the latest review-code manual-validation items. Then run `agent-infra-internal platform-pr inspect {task-id}` and use the reference status matrix to discover, merge, and number items. Only automatic mode stops before started when reliable sources are empty or the sole possible source is unreadable; valid explicit mode always continues with the user command as effective work.
3. Take the round and artifact name from the core result. After confirming valid explicit work or a non-empty discovered list, run `agent-infra-internal task-event {task-id} validation-run.started --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code}` and classify each item as `executable|unavailable|unknown|unsafe|unresolved`.
4. Invoke every executable item separately with `agent-infra-internal task-validate {task-ref} --scope snapshot --format json -- {command...}`. Only make a second explicit inplace invocation for that item when evidence proves it is required. If no item is executable, run no fabricated command but still produce coverage-gap evidence.
5. Read `reference/report-template.md`, create `validation-run.md|validation-run-r{N}.md`, and record the input mode, discovered list, per-item results, CLI JSON allowlist, and sanitized summaries.
6. Run `agent-infra-internal task-event {task-id} validation-run.completed --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code} --artifact {artifact}`. When an Issue exists, run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}` and then `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {artifact} --agent {standard-agent-token}`.
7. Run `agent-infra-internal task-verify {task-id} validation-run.completed --artifact {artifact} --format text`; fix failures and rerun it.
8. Report the evidence path, coverage gaps, and verification result; explicitly leave the decision to run `complete-manual-validation` to the maintainer. Read `.agents/rules/next-step-output.md` and end with `Completed at`.

## Scenario B: Branch-Only Fallback

With `--branch <ref>`, only the following differ from the steps above; every other constraint (classification, per-item execution, sanitization, never changing PR manual validation state) still applies.

- **Explicit mode only**: `task-artifact` and `platform-pr inspect` both require a task ref, so branch-only cannot discover items. Stop before writing any artifact when the user command after `--` is missing.
- **Skip Step 0 and the Step 2 discovery**: record both sources as `unavailable` and list this round's items under the `explicit` source in the artifact's `## Discovered Items` section.
- **Step 3 skips only the event call**: emit no `validation-run.started`, but still classify every item as `executable|unavailable|unknown|unsafe|unresolved`.
- **Step 4 runs unchanged**: `agent-infra-internal task-validate {branch-ref} --scope snapshot --format json -- {command...}`.
- **Step 5 relocates the artifact**: write `.agents/workspace/validations/{branch-slug}/validation-run.md|validation-run-r{N}.md` using the same `reference/report-template.md`. Derive `{branch-slug}` from the `--branch` ref character by character: keep `[A-Za-z0-9._-]` and replace everything else (including `/`) with `-`, so the result is a single path segment; if the result is empty or consists only of `.`, treat it as invalid input and stop before writing any artifact.
- **Skip Steps 6 and 7**: emit no `validation-run.completed`, run no `platform-comment sync`, and run no `task-verify`.
- **Step 8 adds a notice**: state that the artifact is unrecoverable and unregistered, and must be carried back to the host owning the task workspace before a maintainer runs `complete-manual-validation`.

## Completion Checklist

- [ ] Used `agent-infra-internal task-validate` for every executable item, or recorded that none were executable
- [ ] Recorded sanitized validation-run evidence
- [ ] Did not change PR manual validation completion state
- [ ] Updated task.md and passed completion verification (branch-only instead: recorded `recoverable: false` and left the task ledger untouched)
