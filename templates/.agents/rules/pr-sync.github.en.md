# PR Summary Synchronization

> `--agent` values follow the "Collaborator Token Specification" in `.agents/rules/task-management.md`: standard AI short tokens (`claude`/`codex`/`gemini`/`opencode`/`cursor`), long-name normalization (`claude-code`->`claude`, `gemini-cli`->`gemini`), or the `human` manual exception.

The model writes the semantic reviewer summary. Typed core owns canonical artifact selection, marker/HEAD wrapping, paginated comment lookup, and reconciliation.

## Three-Layer Isolation

- `sync-pr:{task-id}:summary` (`platform-pr summary-sync`) is an updatable reviewer summary; it is neither a process copy nor a formal Review.
- The full `pr-review*` process copy lives in the Issue artifact comment (`platform-comment sync --kind artifact`) and is restored by `restore-task` under its Issue-only contract.
- A formal PR Review (`platform-pr-review publish`) is the only formal conclusion carrier published to the PR, bound to the reviewed head SHA, and includes conclusion, findings, receipt, and the Issue artifact link.

The three never cross: a regular PR comment does not carry the full process copy; an Issue artifact comment is not treated as a formal Review; a summary is not presented as a formal Review.

```bash
agent-infra-internal platform-pr summary-context {task-id}

agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {standard-agent-token} --body-file {summary-body-file}
```

Use only canonical inputs returned by the context command. Write the plain body without marker or SHA. The core owns `<!-- sync-pr:{task-id}:summary -->`, current `<!-- last-commit: ... -->`, create/update/no-op behavior, and duplicate-marker conflicts. Summary failure never rolls back a PR or commit.

The canonical comment envelope produced by the core is:

```markdown
<!-- sync-pr:{task-id}:summary -->
<!-- last-commit: {git-head-sha} -->
## Review Summary
{manual-validation-section}
### Key Technical Decisions
### Review History
### Test Results
```

Canonical inputs include `manual-validation.md`. The manual-validation section is one of `### ✅ Manual Validation Passed`, `### ⚠️ Manual Verification Required`, or `### ✅ No Manual Verification Needed`; `complete-manual-validation` refreshes the same summary in place.

```bash
agent-infra-internal task-warning {task-id} add --step {step} --severity WARNING \
  --code COMMENT_SYNC_FAILED --target pr-summary --message "{reason}" \
  --action "Restore comment permission or connectivity and rerun this step"
```
