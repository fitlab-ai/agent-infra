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
  --change-report-file <task-workspace>/active/{task-id}/pr-change-report.json \
  --result {primary-result}
```

Use only canonical inputs returned by the context command. The precheck must contain file evidence for six fixed checks; `formalReview` is always false and `needs-review` routes to `review-code`. Generate a typed JSON payload with `overview:string`, `tests:{state,detail}`, `review:{state,detail}`, `manualValidation:{state,detail}`, `humanDecisions:{open,resolved,detail}`, and `risks:string`. Detail fields are non-empty, counts are non-negative integers, and structure checks do not assess semantic quality. Use `not-started`/`pending` for tests that have not started, `none`/`not-observed`/`not-published` for absent or unobserved remote Reviews, and `pending` for manual validation that has not run. Human-decision counts come from the task ledger. The renderer supplies fixed sections and the canonical report placeholder. The core validates the task-intent digest, bound PR identity, complete patch SHA, and mechanical totals before rendering the report, then owns markers, HEAD metadata, and create/update/no-op behavior.

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

Canonical inputs include `manual-validation.md`. The manual-validation `state` can be `required`, `pending`, `passed`, `none`/`not-required`, or `not-observed`. English headings such as `### ⚠️ Manual Verification Required`, `### ✅ Manual Validation Passed`, and `### ✅ No Manual Verification Needed` are documentation labels; the current renderer emits Chinese headings. `complete-manual-validation` refreshes the same summary in place. The PR code-change section uses authoritative base/head facts from `platform-pr inspect` and the complete `git diff --find-renames --numstat base...head`, reconciles runtime, test, skill/rule, template, documentation, and other categories, and explains renames, mechanical mirrors, and potentially unnecessary changes. The core renderer supplies the canonical `### PR Code Changes` section. After publishing, the core reads comments back and requires one summary marker with a body that exactly matches the canonical rendered body; mismatch or read failure uses the existing coordinator/recovery path.

Examples include `required`, `pending`, `passed`, `none`/`not-required`, and `not-observed`; this list is illustrative, not exhaustive. The renderer also accepts `unavailable` and other non-empty states through its existing fallback. English headings below are documentation labels; the current renderer emits the stated Chinese headings. `required` retains each item, location, and reason under `### ⚠️ 需人工校验`. `pending` means validation has not started or remains incomplete and renders as `### ⏳ 人工验证待收尾`. `passed` (`### ✅ Manual Validation Passed` in this documentation; `### ✅ 人工验证已通过` from the renderer) is publishable only through the final `complete-manual-validation` coordinator after it writes a valid receipt. Preserve the receipt marker bound to the transaction, receipt, evidence, and current PR head; never infer passed status from summary text or another state. `none`/`not-required` renders as `### ✅ 无需人工校验` only when no manual item is required and carries no passed receipt. `not-observed` means the state has not been read and renders as `### ℹ️ 尚未读取人工校验状态`.

```bash
agent-infra-internal task-warning {task-id} add --step {step} --severity WARNING \
  --code COMMENT_SYNC_FAILED --target pr-summary --message "{reason}" \
  --action "Restore comment permission or connectivity and rerun this step"
```
