# Compatibility Policy

This rule governs compatibility decisions during analysis, planning, implementation, and review. Support the current contract by default. Compatibility is an exception budget that requires evidence and an exit condition; it is not a synonym for safety.

## What Counts as Compatibility

Compatibility logic includes accepting or writing multiple generations of schemas, fields, states, or commands; retaining legacy aliases, adapters, wrappers, or shims; migrating data in the normal runtime path; falling back to different semantics based on an old format; or maintaining parallel facts and tests for old callers.

Current-operation idempotency and crash recovery, explicit platform or permission capability branches, fail-closed handling of unknown state, and user-required public multi-version contracts are not inherently legacy compatibility. Do not use those labels to expand support for an old protocol.

## Admission Gate

Add or extend compatibility only when the task or an existing public contract explicitly requires it and the artifact records all four items:

1. **Subject**: concrete consumers, released versions, or stored data still using the old contract.
2. **Necessity**: why an atomic cutover, one-time conversion, or actionable failure is insufficient.
3. **Window**: a version, date, or verifiable endpoint for the compatibility period.
4. **Exit**: removal conditions and the code, tests, and documentation to delete.

If any item is missing, compatibility is unauthorized scope expansion. Implement the current contract, fail closed with an actionable repair message for old input, or perform an explicit one-time conversion outside the main path.

## Implementation Boundaries

- Keep one canonical write format and one source of truth. Do not dual-write, maintain shadow state, or try the new path before silently falling back to the old path.
- Concentrate an approved conversion at one boundary and immediately enter the current model; business logic must not understand several historical versions.
- Mark temporarily retained compatibility at its single boundary with `TODO(compat): Remove ... once ...`, naming the removal target and a verifiable removal condition. The TODO stays co-located with the code; tasks and issues are optional scheduling aids, not compatibility facts or workflow gates.
- Use warnings only when the primary action remains correct and the user can retry an ancillary operation. Never hide uncertainty about identity, authorization, data interpretation, or side-effect correctness.
- When removing an old capability, remove its adapters, branches, fixtures, tests, and migration documentation together. Do not add negative tests that permanently remember deleted behavior.
- Never guess the meaning of unknown state. Preserve it, stop writes, and provide rebuild or manual-repair guidance.

## Lifecycle Requirements

- **Analysis**: separate explicit compatibility requirements from model speculation and identify real consumers or stored data. State current-only when evidence is absent.
- **Plan**: for approved compatibility, identify the boundary, single conversion point, window, and deletion plan. Do not present a compatibility layer as the default low-risk option.
- **Implementation**: implement only the approved compatibility budget, and add or move its `TODO(compat)` at the single compatibility boundary. Do not preserve an unapproved old branch “just in case.”
- **Review**: verify the four admission items, single source of truth, exit condition, and co-located `TODO(compat)`. Flag unauthorized compatibility, indefinite shims, dual writes, and runtime-path migrations as scope and maintainability problems.

## Existing Compatibility Logic

During an ordinary task, when out-of-scope compatibility is found, only ensure that its single boundary has one `TODO(compat)` and record the location and risk. Do not delete the logic or duplicate the marker. A dedicated simplification task should first search those TODOs and inventory consumers and stored data, then process items in this order: remove now, warn then remove, retain temporarily.
