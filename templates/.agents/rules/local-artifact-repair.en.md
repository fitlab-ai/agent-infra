# General Rule - Model-Driven Local Artifact Repair

This rule applies when `analyze-task`, `plan-task`, or `code-task` handles **the same controlled local artifact** before its completed event, and when `review-analysis`, `review-plan`, or `review-code` handles a finalizer failure for **the same controlled review artifact**. It does not apply to `task.md`, the ledger, receipts, source code, Git, platform resources, or lifecycle state.

## Pre-completion gate for analysis, plan, and code artifacts

- `analyze-task`, `plan-task`, and `code-task` must call `task-artifact ... finalize-local` before publishing a completed event; pass only that call's `artifactSha256` and `semanticDigest` to the completed event.
- `finalize-local` does not modify the artifact or task state, but it writes a one-shot local provenance intent in the repository workspace. After `failed`, the model may make one minimal edit in the same artifact only when `repairable=true` and the diagnostic explicitly describes a one-line replacement, then rerun the same call completely; count each byte-changing edit, up to 8.
- The first repairable failure's semantic digest is retained in that intent; a later `passed` result must match the baseline, and the completed event must verify and atomically transition the same intent to `consumed` before writing `task.md` under the task lock. A consumption failure must not write the task; the consumed intent is durable and retryable, so no failure-prone post-write deletion is attempted. Do not replace a failed baseline with a newly computed digest or publish a completed event without the finalizer.
- After `failed`, no progress, or a repeated diagnostic or fingerprint, do not publish a completed event. After `passed`, do not rescan or manually write summary data.

## Authorization Boundary

- The finalizer only reads facts, validates state, normalizes successful results, and performs atomic writes. It does not maintain a recoverable-error allowlist, infer repairability, or choose report content to delete.
- The initial finalizer call is not counted as a repair attempt. Editing is allowed only after the mechanical safety gates pass and the model explicitly determines that the current problem can be solved by a minimal, explainable artifact change.
- The model may edit only the one ordinary local artifact declared by the current skill, and the file must be inside the current task directory. It must not edit `task.md`, the review disagreement ledger, receipts, source code, other reports, or remote resources.
- `changed=false`, an error code, or a format shape is diagnostic evidence, not automatic authorization. The model must judge each case using the complete diagnostic, artifact content, and context.

## Non-bypassable Mechanical Safety Gates

Before every model edit, confirm that:

1. the finalizer returned a failure and no artifact operation was committed;
2. the task, stage, artifact, review round, identity, and provenance still match;
3. the target is an ordinary file inside the current task directory, with no concurrency conflict, permission error, I/O uncertainty, or target replacement;
4. the change does not alter human-decision semantics, decision-detail or ledger identity, and does not involve task state, receipts, Git, platform, or any other external side effect. A known and verifiable pending human decision may remain when the model proves the edit is unrelated to that decision.

If any condition fails, stop immediately without invoking a model edit. The model cannot bypass these gates.

## Dynamic Convergence Loop

1. Run the initial finalizer with the fixed task, stage, artifact, and orchestrated intent.
2. On success, use that complete result for the existing completion gates; do not rescan the ledger or write summary fields manually.
3. On failure with the safety gates passed, let the model read the structured diagnostic, current artifact, and required context, then decide whether to repair or stop. It must explain the scope and reason for the proposed change.
4. If the model continues, perform one minimal edit to the artifact. Increment `repairAttempts` only when the file bytes actually change, then rerun the same finalizer intent completely.
5. Re-run every safety check after each retry. A new, independent problem still limited to the same artifact may be offered to the model for another decision; the previous repairability decision must not be reused automatically.
6. Stop immediately when the model cannot establish safety or identifies an environment, permission, concurrency, identity, provenance, unknown-state, uncertain human-decision semantics/details, or other non-local problem. A known human decision is not itself a stop condition.
7. Stop when the diagnostic or artifact fingerprint repeats, no byte-level progress occurs, or the model cannot propose a verifiable minimal change.
8. Allow at most 8 actual artifact edits per skill invocation as an emergency circuit breaker. This cap only prevents infinite loops and resource exhaustion; it is not a normal business stop condition and does not mean that at most eight problems may be repaired. Preserve the final structured diagnostic when the cap is reached.

The repair count exists only in the in-memory context of the current skill invocation. Do not write it to `task.md`, the ledger, or a public receipt. Do not create different normal budgets by error code, skill, or problem type.

## Shared Structural Engine

The report skeleton is created by `agent-infra-internal task-artifact {task-id} init --family {family} --artifact {artifact}`. The skeleton writes only identity, headings, and `artifact-section:{family}:{section-id}` markers; it does not represent semantic completion. The current skill must fill each slot with real content. When the finalizer returns one provably safe structural operation, use that result's SHA and semantic digest with `task-artifact {task-id} repair --family {family} --artifact {artifact} --expected-sha256 {artifact-sha256} --expected-semantic-digest {semantic-digest}`. Repair executes only the one operation from the shared engine, does not write `task.md`, the ledger, receipts, Git, or platform resources, and must be followed by a complete rerun of the original finalizer.

## Completion Events and User Output

- After the final complete finalizer result succeeds, publish the review completed event using that same result's provenance, ledger state, verdict, and counts. Generate cross-stage next-step commands only when `stageStatus.canAdvance=true` and the verdict is Approved; when `canAdvance=false`, still record the result and route to same-stage revision/review.
- On failure, model stop, lack of progress, repeated diagnostics, or the emergency cap, do not publish a completed event, advance the lifecycle, generate cross-stage commands, or fabricate an approval.
- Stopping advancement does not discard review results. User output must show the artifact path, the last safely readable summary/findings, actual `repairAttempts`, the last structured diagnostic, and the stop reason.
- If the summary cannot be safely parsed, show only the artifact path and the raw structured diagnostic; do not infer counts or add a conclusion, and state that lifecycle advancement stopped while the artifact remains available.
- A stop path may only suggest rerunning the current review skill or handling the issue manually. It must not invoke cross-stage helpers such as `code-task` or `complete-task`.

## Lifecycle Isolation

`complete-task`, alert closing, task restoration, and other task-lifecycle/task-finalization entry points involve task state, receipts, remote results, or archival side effects and do not consume this rule. They retain their own hard-stop, same-intent retry, and unknown-state semantics.
