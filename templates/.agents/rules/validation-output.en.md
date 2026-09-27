# Validation Output Summary

This rule governs how `task-verify --format text` and lifecycle skills present validation results to users. It does not change validation logic, structured results, or persisted evidence requirements.

## Overall Summary

- Show the overall status, validation target, and pass, fail, and blocked counts.
- For successful results, show only the summary; do not list passing check names.
- Keep failure and blocked states distinct. List only effective failed or blocked checks, with a stable identifier, concise reason, and actionable step.
- A soft check whose raw status is failed but effective status is pass must not count as a failure. When a user-facing notice is needed, show a concise warning with the necessary reason and action.

## Consumer Boundaries

- Do not copy complete successful stdout into the final response. Read structured details or rerun the command when passing check details are needed.
- Consume structured host finalization results through their status, receipt, and warning projection; do not present receipt contents as the user summary.
- Persisted lifecycle reports continue to follow `evidence-reporting.md`, recording reproducible scope, status, and necessary evidence. Issue artifact comments continue to sync the required report content.
- JSON payloads, check order, check set, effective-status decisions, and exit codes remain unchanged.
