# Host Contract Validation

Before publishing support for a client, prove the lifecycle evidence chain with real host events. Bridge tests prove field mapping only; they do not prove host provenance.

## Required Evidence

- Client version, enabled multi-agent capability, launch surface, and trust boundary.
- Raw start/stop events, or the parent PostTool spawn/completed-wait fallback when custom roles omit them, stably correlate the managed agent, parent/child identity, fresh spawn mode, actual model, and actual reasoning effort.
- Explicit requested model/effort reaches each executor/reviewer. A fallback of either field reports the corresponding actual value and its own non-empty reason.
- Candidate-checkout and packed-install behavior match, with model policy, receipts, and verification results auditable in `orchestration.json`.
- Direct-host project/managed source and sandbox isolated-user source preserve the same build, contract, profile, and controller provenance through prepare/start/stop/consume.

## Validation Sequence

1. Record client version, feature state, and launch command in a clean temporary repository.
2. Start a fresh executor and reviewer, retaining redacted raw stdin and the structured run. Validate both native start/stop and the parent PostTool fallback; timed-out waits must do nothing. Never synthesize a field the host did not emit.
3. Validate model/effort match paths, single and dual justified fallbacks, and fail-closed behavior for missing actual fields.
4. Validate the same commit from a candidate checkout and an `npm pack` install; record the tarball hash and results.
5. Commit only redacted summaries and non-sensitive fixtures. Remove or replace tokens, user-specific absolute paths, transcript content, and credentials.
6. For sandbox, run at least ten cold executor starts and ten cold reviewer starts. Record monotonic prepared, spawn-dispatch, SubagentStart, and activation-completed timestamps plus p50/p95/max. Enable only when max plus 20% fits the deadline and symlink/config/plugin/lease/context/build failure injection and terminal cleanup audits pass.

If any required field cannot be observed reliably from the real host, keep that client's orchestration capability `unsupported` and record the gap as manual validation. Codex may advertise `experimental`, but every `prepare` must still pass static preflight and either native start/stop or the parent spawn/completed-wait fallback must produce verifiable consumed host evidence. The fallback may wait only for empty turns or protocol `inProgress`; malformed, identity/transport errors, or abnormal terminals pause deterministically.
