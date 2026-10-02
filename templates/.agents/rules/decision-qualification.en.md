# Decision Qualification and Constraint Audit

Any analysis, plan, implementation, or review that decides whether a human decision is needed must audit qualification from the normalized constraints and candidates in `task.md` before creating `HD-N`.

## Single source of truth

- The `### Constraints` and `### Candidate and Rejected Options` tables in `task.md` are the only constraint and candidate fact source.
- The constraint table uses `constraint_id`, `statement`, `status`, `authority`, `source`, `evidence`, `derived_from`, and `approval_evidence`; the candidate table uses `candidate_id`, `statement`, `status`, `constraint_ids`, `impact`, and `evidence`.
- Qualification audits are optional in all six lifecycle artifact families. When `## Qualification Audit` is present, it must contain three decision tables (constraint dependencies, candidate qualification, classification results) and one snapshot row (`task_input_digest`, `non_constraint_input_digest`). Candidate qualification must cover the complete candidate set in the task.
- Lifecycle input relationships belong in the `Artifact Lifecycle Receipts` section of `task.md`. Freeze each stage's actual artifact inputs and SHA-256 values at stage start, then verify and record each input edge at completion. Do not duplicate lifecycle edges in qualification audits.

## Status and confirmation

- A `confirmed` constraint requires source evidence, the current semantic digest, and a qualification confirmation record; a confirmation for an old digest cannot be reused.
- `derived`, `assumption`, `open`, `conflicted`, and `superseded` are pending facts and cannot automatically exclude a candidate.
- The internal proposal entry point may write only non-confirmed constraints and `pending` candidates. It cannot write actor, QCR, confirmed, or approval fields.
- `agent-infra-internal task-qualification` is the internal confirmation, supersession, and revocation entry point for agents and skills; ordinary users are not exposed to the constraint-digest protocol. `human-declared` is an audit label, not identity authentication. On confirmation, the core generates the QCR and binds it to the current post-write per-constraint digest, request id, time, and a single-line rationale. Supersession and revocation move the constraint to `superseded` and `open`, respectively, clear current approval evidence, and retain historical QCRs.

## Invalidation and review

The current artifact is the latest successfully completed report with a matching completion fact, current file digest, and paired completion log. A filename round or modification time alone does not prove completion. Downstream reports must continue to verify lifecycle receipts, and review-code must verify the reviewed snapshot identity. Resume an open started round in place; pending rework intent determines the return stage. Existing “Artifact Invalidation” sections are historical text only and do not affect current reports, authorization, routing, or recovery. Editing them does not change the task-input digest.

When a qualification audit is present, missing or unknown references and digest mismatches block finalization. Audits in the old format with an upstream-relations table must be regenerated in the current format. Formatting-only changes must not change semantic digests; changes to meaning, provenance, status, or candidates require a new audit.
