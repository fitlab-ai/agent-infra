# Host Contract Validation

Before publishing support for a client, prove the lifecycle evidence chain with real host events. Bridge tests prove field mapping only; they do not prove host provenance.

## Required Evidence

- Client version, enabled multi-agent capability, launch surface, and trust boundary.
- Raw start/stop events stably provide event type, managed agent, parent/child identity, fresh spawn mode, and actual model.
- The explicit requested model reaches each executor/reviewer. A host fallback reports both the actual model and a non-empty fallback reason.
- Candidate-checkout and packed-install behavior match, with model policy, receipts, and verification results auditable in `orchestration.json`.

## Validation Sequence

1. Record client version, feature state, and launch command in a clean temporary repository.
2. Start a fresh executor and reviewer, retaining redacted raw stdin and the structured run. Never synthesize a field the host did not emit.
3. Validate requested/actual match and justified-fallback paths, plus fail-closed behavior for missing fields.
4. Validate the same commit from a candidate checkout and an `npm pack` install; record the tarball hash and results.
5. Commit only redacted summaries and non-sensitive fixtures. Remove or replace tokens, user-specific absolute paths, transcript content, and credentials.

If any required field cannot be observed reliably from the real host, keep that client's orchestration capability `unsupported` and record the gap as manual validation.
