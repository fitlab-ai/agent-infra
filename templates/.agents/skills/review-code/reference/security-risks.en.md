# Security Risk Review

## Scope

Use when changes touch authentication, authorization, untrusted input, sensitive data, credentials, cryptography, dependencies, or system boundaries.

## Review Questions

- Are trust boundaries, permission checks, and deny-by-default behavior explicit?
- Do input validation, output encoding, secret handling, and logging avoid expanding exposure?
- Do new dependencies or system calls introduce capabilities or supply-chain risks outside the approved plan?

## Evidence Requirements

Trace the call chain or data flow from entry through validation, authorization, use, and failure exits. Support conclusions with tests, specification conflicts, or accurate locations.

## Common Counterexamples

- Assuming safety merely because a security-related API is used.
- Checking only the happy path while ignoring bypasses and failure defaults.
- Treating unavailable real credentials or external systems as blockers by default.

## When Closure Is Not Possible

Record reproducible defects as findings, checks requiring real permissions or external systems as manual-validation, and unsupported uncovered boundaries as a gap. Do not approve unconditionally.
