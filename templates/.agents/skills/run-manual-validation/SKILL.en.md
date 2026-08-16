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

1. Resolve `{task-ref}`, the validation target, and the command after the literal `--`; stop without writing an artifact if any is missing.
2. Run `agent-infra-internal task-artifact {task-id} inspect --family validation-run`, take the round and artifact name from the core result, then run `agent-infra-internal task-event {task-id} validation-run.started --agent {standard-agent-token}`.
3. Use snapshot for fixed-commit checks and inplace for uncommitted content, original mounts, or original permissions; when uncertain, start with snapshot and upgrade only with evidence.
4. Call `ai task validate {task-ref} --scope {scope} --format json -- {command...}`. A runtime upgrade must be a second explicit inplace call with its reason recorded.
5. Read `reference/report-template.md`, create `validation-run.md|validation-run-r{N}.md`, and record only the CLI JSON allowlist and a sanitized summary.
6. Run `agent-infra-internal task-event {task-id} validation-run.completed --agent {standard-agent-token} --artifact {artifact}`. When an Issue exists, run `agent-infra-internal platform-comment sync {task-id}` and then `agent-infra-internal platform-comment sync-artifact {task-id} --artifact {artifact}`.
7. Run `agent-infra-internal task-verify {task-id} validation-run.completed --artifact {artifact} --format text`; fix failures and rerun it.
8. Report the evidence path, coverage gaps, and verification result; explicitly leave the decision to run `complete-manual-validation` to the maintainer. Read `.agents/rules/next-step-output.md` and end with `Completed at`.

## Completion Checklist

- [ ] Used `ai task validate`
- [ ] Recorded sanitized validation-run evidence
- [ ] Did not change PR manual validation completion state
- [ ] Updated task.md and passed completion verification
