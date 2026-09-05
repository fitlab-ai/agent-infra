# PR Summary Synchronization

> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.

The model writes the semantic reviewer summary. Typed core owns the task-intent digest, complete three-dot diff, canonical `pr-change-report.json` sidecar, report rendering, authoritative PR-head wrapping, paginated comment lookup, and reconciliation.

## Three-Layer Isolation

- `sync-pr:{task-id}:summary` (`platform-pr summary-sync`) is an updatable reviewer summary; it is neither a process copy nor a formal Review.
- The full `pr-review*` process copy lives in the Issue artifact comment (`platform-comment sync --kind artifact`) and is restored by `restore-task` under its Issue-only contract.
- A formal PR Review (`platform-pr-review publish`) is the only formal conclusion carrier published to the PR, bound to the reviewed head SHA, and includes conclusion, findings, receipt, and the Issue artifact link.

The three never cross: a regular PR comment does not carry the full process copy; an Issue artifact comment is not treated as a formal Review; a summary is not presented as a formal Review.

```bash
agent-infra-internal platform-pr summary-context {task-id}

agent-infra-internal platform-pr change-report {task-id} \
  --agent {standard-agent-token} --mechanical-file {mechanical-report-file} \
  --precheck-file {precheck-candidate-file}

agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {standard-agent-token} --body-file {summary-body-file} \
  --change-report-file .agents/workspace/active/{task-id}/pr-change-report.json \
  --result {primary-result}
```

Use only canonical inputs returned by the context command. The precheck must contain file evidence for six fixed checks; `formalReview` is always false and `needs-review` routes to `review-code`. Write the plain body with exactly one `<!-- canonical-pr-change-report -->` placeholder, without a report heading/JSON, marker, or SHA. The core validates the task-intent digest, bound PR identity, complete patch SHA, and mechanical totals before rendering the report, then owns `<!-- sync-pr:{task-id}:summary -->`, authoritative `<!-- last-commit: ... -->`, create/update/no-op behavior, and duplicate-marker conflicts. Missing, stale, invalid, or bypassed report input never publishes; summary failure never rolls back a PR or commit.

The canonical comment envelope produced by the core is:

```markdown
<!-- sync-pr:{task-id}:summary -->
<!-- last-commit: {git-head-sha} -->
## Review Summary
{manual-validation-section}
### Key Technical Decisions
### Review History
### Test Results
### PR Code Changes
```

Canonical inputs include `manual-validation.md`. The manual-validation section is one of `### ✅ Manual Validation Passed`, `### ⚠️ Manual Verification Required`, or `### ✅ No Manual Verification Needed`; `complete-manual-validation` refreshes the same summary in place. The PR code-change section uses authoritative base/head facts from `platform-pr inspect` and the complete `git diff --find-renames --numstat base...head`, reconciles runtime, test, skill/rule, template, documentation, and other categories, and explains renames, mechanical mirrors, and potentially unnecessary changes. The caller supplies the placeholder; the core renderer supplies the canonical `### PR Code Changes` section.

```bash
agent-infra-internal task-warning {task-id} add --step {step} --severity WARNING \
  --code COMMENT_SYNC_FAILED --target pr-summary --message "{reason}" \
  --action "Restore comment permission or connectivity and rerun this step"
```
