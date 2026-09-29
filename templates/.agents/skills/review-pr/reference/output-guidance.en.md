# Output Guidance

Read this file and `.agents/rules/next-step-output.md` before presenting the final result to the user. `review-pr` has exactly three exits; pick exactly one based on the run outcome.

## Exit Selection

| Exit | Trigger | Present |
|------|---------|---------|
| A Local review complete | the local review round closed and verification passed; formal publication succeeded or has a durable pending record | conclusion, mode, reviewed head SHA, actual publication status, Review URL or recovery action, receipt, next step |
| B Blocked, requires linking | `resolve-host` returned none or ambiguous | linking guidance (create/link an Issue and task); do not auto-create an Issue; or explicitly choose the one-shot review |
| C One-shot review | the user explicitly chose a "one-shot review" | non-recoverable notice, artifact directory `.agents/workspace/reviews/{pr-number}/`, Review URL or publication failure |

## Presentation Requirements

- On local completion (exit A), report the review mode (verify/audit/reconstruct), evidence scenario (S1/S2/S3), reviewed head SHA, finding count, formal publication status, Review URL or pending recovery operation, and receipt. Never claim a pending Review was published.
- On block (exit B) provide concrete commands/steps to establish the link; if `resolve-host` returned `ambiguous`, list the candidate tasks and ask a human to pin the host.
- On one-shot (exit C) state clearly `recoverable: false` and make no recovery promise.
- Read `.agents/rules/next-step-output.md` before rendering the next step, and generate the "next step" command per its convention.
