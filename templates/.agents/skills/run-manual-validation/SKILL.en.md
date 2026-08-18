---
name: run-manual-validation
description: >
  Safely run task manual validation on the host and record standard evidence.
  Use when validation needs host credentials, a real container, or in-place worktree state.
  Only invoke automatically when the conversation includes a resolvable task reference.
---

# Run Manual Validation

## Boundary

- Select the validation mode, call the sole mechanical entry point, and record evidence; do not mark PR manual validation complete.
- `complete-manual-validation` remains the maintainer's final registration after coverage is judged sufficient.
- Never manipulate temporary worktrees, leases, or containers directly; only call `ai task validate`.
- Never record tokens, environment variables, full argv, absolute user paths, or raw transcripts in the artifact.

## Step 0: State Check (pre-execution hard gate)

Resolve the task reference, then run this command and copy its original output into the artifact:

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

## Steps

1. Read `reference/discovery-and-execution.md` and parse the input mode. Stop before started without an artifact for invalid or partial input.
2. Run `agent-infra-internal task-artifact {task-id} inspect --family validation-run` and read the latest review-code manual-validation items. Then run `agent-infra-internal platform-pr inspect {task-id}` and use the reference status matrix to discover, merge, and number items. Only automatic mode stops before started when reliable sources are empty or the sole possible source is unreadable; valid explicit mode always continues with the user command as effective work.
3. Take the round and artifact name from the core result. After confirming valid explicit work or a non-empty discovered list, run `agent-infra-internal task-event {task-id} validation-run.started --agent {standard-agent-token}` and classify each item as `executable|unavailable|unknown|unsafe|unresolved`.
4. Invoke every executable item separately with `ai task validate {task-ref} --scope snapshot --format json -- {command...}`. Only make a second explicit inplace invocation for that item when evidence proves it is required. If no item is executable, run no fabricated command but still produce coverage-gap evidence.
5. Read `reference/report-template.md`, create `validation-run.md|validation-run-r{N}.md`, and record the input mode, discovered list, per-item results, CLI JSON allowlist, and sanitized summaries.
6. Run `agent-infra-internal task-event {task-id} validation-run.completed --agent {standard-agent-token} --artifact {artifact}`. When an Issue exists, run `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}` and then `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {artifact} --agent {standard-agent-token}`.
7. Run `agent-infra-internal task-verify {task-id} validation-run.completed --artifact {artifact} --format text`; fix failures and rerun it.
8. Report the evidence path, coverage gaps, and verification result; explicitly leave the decision to run `complete-manual-validation` to the maintainer. Read `.agents/rules/next-step-output.md` and end with `Completed at`.

## Completion Checklist

- [ ] Used `ai task validate` for every executable item, or recorded that none were executable
- [ ] Recorded sanitized validation-run evidence
- [ ] Did not change PR manual validation completion state
- [ ] Updated task.md and passed completion verification
