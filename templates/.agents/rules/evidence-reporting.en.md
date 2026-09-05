# Lifecycle Evidence Reporting

This rule governs lifecycle reports persisted in the task workspace or synchronized to an Issue. It defines the minimum evidence semantics without changing artifact identity, receipts, synchronization, or restore protocols.

## State Check

- Record the `task-snapshot` command and its task, artifact, and scope.
- For normal results, record the key conclusion and exceptions; do not repeat the full directory listing or `task.md` tail.
- For identity mismatches, failures, blocking conditions, or disputes, retain the decisive raw lines that support the judgment.

## Successful Checks

Every successful check records the command or an allowed public command name, target and scope, exit status or structured result, actual result, and uncovered parts. Do not write only “passed” or “tests passed”, and do not paste complete successful stdout by default.

## Failures, Blocking Conditions, and Disputes

Record a reproducible command or entry point, the exact file/line/object/version location, exit status, and the smallest decisive excerpt supporting the conclusion. If reproduction is unavailable, state the limitation explicitly rather than presenting incomplete evidence as success.

## Preserved Identity and Security Boundaries

- Preserve artifact SHA-256, semantic digest, review head, receipt, request-id, snapshot tree, and platform marker exactly.
- The Issue continues to mirror the complete report; the report must not depend on logs accessible only on the local machine.
- Manual validation keeps its stricter basename-only and sanitized-result rules; this shared rule does not expand public fields.
- A `$ ` command line satisfies the structural gate but does not require complete successful output.

## Evidence Pairing

Pair every verification claim with a `$ ` command and a proportionate result summary. Include a decisive raw excerpt only for failure, blocking, or dispute conclusions. When a command contains sensitive arguments, use its allowed public name or a redacted command.
