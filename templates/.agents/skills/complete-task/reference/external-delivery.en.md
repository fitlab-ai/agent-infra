# External PR Delivery

This scenario applies only to an active task whose completion canonical inventory is empty because an already-merged external PR delivered the implementation.

## Typed State Machine

Run `agent-infra-internal platform-pr resolve-external {task-id} --agent {agent} [--pr {N}]`. Core checks the completion inventory first. A non-empty inventory returns `mode=normal`, and supplying `--pr` then fails. An empty inventory requires a positive `issue_number`; otherwise core returns `EXTERNAL_DELIVERY_ISSUE_REQUIRED`.

The platform adapter supplies authoritative Issue closing change requests across all pages. Only candidates with a matching base repository, complete identity, and merge evidence are eligible. One candidate is selected automatically; ambiguity, conflicts, and missing evidence fail closed. `--pr` may only select an authoritative eligible closing candidate and cannot bypass repository, Issue, merge, or identity validation.

## Authorization and Persistent Audit

Only the current typed result's `mode=external`, `authorization`, and `selected` fields control the machine branch. `pr_status: created` is a compatibility shim for existing verifiers: it means a verifiable PR is bound, not that this task created it, and it cannot authorize lifecycle skipping by itself.

A successful bind atomically writes PR fields and appends a `Bind External PR` Activity Log entry containing the authorization source, Issue, PR URL/number, base/head repository/ref/SHA, merge time, and merge commit. Replaying identical complete evidence is a no-op; an existing same-number binding without the signature adds it once; number or identity changes fail. The PR create path must never run.

External mode still passes review-ledger, manual-validation, post-review-commit, platform-sync, preflight, and terminal gates. Without a canonical review-code artifact, only existing verifier N/A rules apply. `--force` does not disable any hard gate.
