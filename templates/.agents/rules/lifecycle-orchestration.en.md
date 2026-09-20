# Common Rule - Lifecycle Orchestration

## Guarantee Boundary

- The orchestrator only routes and delegates. Stage skills remain the single source of truth for behavior and artifacts.
- Every stage and rework round uses a fresh executor. Every review uses a fresh reviewer; follow-up reuse is forbidden.
- A reviewer may only write its review artifact and core-generated task metadata. Business-code, HEAD, or index changes invalidate the receipt.
- An active run has one pending delegation. Keep the stage associated with the observed child and report actual start and terminal failures.
- The first release ends after one existing safely gated `commit`; it does not create a PR, monitor checks, or complete the task.

## Current Execution Records

`orchestration.json` records stages, model policy, child identity, and actual outcomes. Records use the current structure; trusted local operators may correct them and rerun validation. Existing task write locks and atomic writes protect updates.

## Current Host

- Use native spawn, wait, and result interfaces from the current host; forward task operations through the existing broker.
- Prepare validates the current task, model policy, and host preflight. Start and terminal records associate observed parent/child identity; failure must not be recorded as success.
- Client-specific preflight, event sources, and recovery transactions belong to the client adapter. The common orchestrator calls only the shared capability and contains no client-ID branches.

## Activated Delegation Recovery

- Before `begin-or-resume`, the orchestrator calls internal `task-lifecycle <task> recover-started --agent <client> --auto`. This entry is not user-facing and never infers child termination from missing liveness evidence.
- The client adapter declares recovery support and owns its candidates, evidence, retries, and persisted state. Unsupported adapters return `no-op`; any result that cannot prove safe completion fails closed.
- `no-op/not-needed` means only that no recovery transaction applies. `begin-or-resume` and route still process the existing state.
- Routing is allowed only when the structured result confirms that recovery is unnecessary or complete. The adapter persists retryable incomplete work as a stable pause and may resume only a pause it created and revalidated; the common orchestrator does not interpret client transaction details.

## Model Policy

- A new run persists model and reasoning effort for both roles. Explicit policy is atomic across all four role fields; only a fully absent explicit policy may fall back to the current client's `agentClients[].orchestration`.
- Route resolves requested model/effort by role, and prepare matches both before snapshotting. Native spawn must not inherit session defaults.
- Native start records host-observed actual model/effort. Fields declared unobservable by the adapter follow the recording rules; each observable mismatch needs its own fallback reason, and requested values must never be fabricated as actual evidence.
- Model selection is labeled as a complete catalog, partial catalog, or interactive-only guidance; a local override enum must not be presented as complete.
- An adapter must declare any policy field it cannot dispatch per role. Values observed in host events are actual evidence only; they do not promise dispatch or gate activation.

## Stable Pause Conditions

Human decisions, manual validation, handshake or step limits, permissions/network failures, worktree conflicts, unsupported client capability, and unknown hook schemas are persisted as pauses. The orchestrator must not ask mid-flow or degrade to same-context self-review.
