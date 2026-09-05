# Decision Qualification and Constraint Audit

Any analysis, plan, implementation, or review that decides whether a human decision is needed must audit qualification from the normalized constraints and candidates in `task.md` before creating `HD-N`.

## Single source of truth

- The `### Constraints` and `### Candidate and Rejected Options` tables in `task.md` are the only constraint and candidate fact source.
- The constraint table uses `constraint_id`, `statement`, `status`, `authority`, `source`, `evidence`, `derived_from`, and `approval_evidence`; the candidate table uses `candidate_id`, `statement`, `status`, `constraint_ids`, `impact`, and `evidence`.
- All six artifact families must include `## Qualification Audit` with actual constraint dependencies, candidate qualification, classification results, upstream relations, and a dependency snapshot. Each upstream relation records family, file name, round, and SHA-256.

## Status and confirmation

- A `confirmed` constraint requires source evidence, the current semantic digest, and a qualification confirmation record; a confirmation for an old digest cannot be reused.
- `derived`, `assumption`, `open`, `conflicted`, and `superseded` are pending facts and cannot automatically exclude a candidate.
- The internal proposal entry point may write only non-confirmed constraints and `pending` candidates. It cannot write actor, QCR, confirmed, or approval fields.
- `agent-infra-internal task-qualification` is the internal confirmation, supersession, and revocation entry point for agents and skills; ordinary users are not exposed to the constraint-digest protocol. `human-declared` is an audit label, not identity authentication. On confirmation, the core generates the QCR and binds it to the current post-write per-constraint digest, request id, time, and a single-line rationale. Supersession and revocation move the constraint to `superseded` and `open`, respectively, clear current approval evidence, and retain historical QCRs.

## Invalidation and review

When a constraint changes, only artifacts declaring the affected `C-N` can be direct invalidation seeds; the change then follows the real downstream closure. All six families, including reviews, are symmetric. If snapshots, relations, or change classification cannot prove a pure constraint change, use the existing full invalidation path. The newly completed source artifact, its receipt, and its derived snapshot are excluded from the old target graph.

Missing or unknown references, digest mismatches, dangling relations, and cycles fail closed. Formatting-only changes must not change semantic digests; changes to meaning, provenance, status, candidates, or upstream identity require a new audit.
