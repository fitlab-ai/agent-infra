# Output Guidance

Read this file and `.agents/rules/next-step-output.md` before presenting the final result to the user. `review-pr` has exactly three exits; pick exactly one based on the run outcome.

## Exit Selection

| Exit | Trigger | Present |
|------|---------|---------|
| A Published | the formal Review was published (applied/no-op) and verification passed | conclusion, mode, reviewed head SHA, Review URL, receipt, next step |
| B Blocked, requires linking | `resolve-host` returned none or ambiguous | linking guidance (create/link an Issue and task); do not auto-create an Issue; or explicitly choose the one-shot review |
| C One-shot review | the user explicitly chose a "one-shot review" | non-recoverable notice, artifact directory `.agents/workspace/reviews/{pr-number}/`, Review URL |

## Presentation Requirements

- On publish (exit A) report: review mode (verify/audit/reconstruct), evidence scenario (S1/S2/S3), reviewed head SHA, finding count, formal Review URL, receipt.
- On block (exit B) provide concrete commands/steps to establish the link; if `resolve-host` returned `ambiguous`, list the candidate tasks and ask a human to pin the host.
- On one-shot (exit C) state clearly `recoverable: false` and make no recovery promise.
- Read `.agents/rules/next-step-output.md` before rendering the next step, and generate the "next step" command per its convention.
