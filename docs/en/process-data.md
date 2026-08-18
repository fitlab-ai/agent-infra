# Process Data Archive

The `ai data` command family preserves development-process evidence as append-only, verifiable snapshots. It captures the local task workspace and currently visible GitHub Issue and pull-request data without changing either source.

## Commands

```bash
ai data capture [--source all|local|github] [--root <dir>] [--include-excerpts]
ai data verify <snapshot-id> [--root <dir>]
ai data audit <snapshot-id> [--root <dir>] [--format json|text]
ai data repair <snapshot-id> [--root <dir>] [--apply]
ai data export <snapshot-id> [--root <dir>] [--repairs none|applied] [--output <file|->]
```

The default root is `.agents/workspace/process-data/`. A custom root must stay inside the repository and cannot overlap a task directory. Exit code `0` means success or an idempotent no-op, `1` means invalid input or failed integrity verification, and `2` means a required source was incomplete or blocked.

This default is host runtime state. Sandboxes do not mount it writable; a default-path capture attempted inside a sandbox therefore fails closed.

`capture` defaults to `--source all`. A local-only or GitHub-only capture is explicitly marked as partial and must not be presented as a complete baseline.

## Storage and Integrity

```text
process-data/
  objects/sha256/<prefix>/<digest>
  snapshots/YYYY/MM/DD/<snapshot-id>/
  repairs/<snapshot-id>/<repair-id>/
  .staging/
```

Content is stored in a SHA-256 content-addressed store. Capture writes to staging and publishes a snapshot with one filesystem rename only after every required source is complete. Existing objects and snapshots are verified and reused; they are never overwritten.

GitHub REST arrays are requested explicitly with `per_page=100&page=N`. Every request page records an item count and `canonicalSha256`. Canonical JSON recursively sorts object keys, preserves array order, and hashes its UTF-8 bytes. This is a semantic JSON representation, not the original HTTP response bytes. Empty terminal pages count as requests and page evidence, but not as data pages.

`verify` recomputes manifest, object, page, and byte-count evidence. `audit` reads the deterministic quality baseline only after verification succeeds.

## Privacy Boundary

Task artifacts and allowlisted GitHub fields are process evidence. Credentials, private keys, bearer tokens, and credential-shaped values are excluded; the manifest keeps only their hash, size, policy rule, and exclusion reason.

Structured telemetry comes from task Activity Logs and recognized delegation or orchestration receipts. Entropy reports remain operational reports. Unknown log formats produce unknown observations instead of guessed telemetry.

Session and tool bodies are unavailable by default. `--include-excerpts` is an explicit opt-in for bounded, redacted excerpts; it never authorizes internal reasoning or secret material.

## Reconciliation and Repair

Quality findings distinguish missing records, duplicate identities, binding conflicts, content differences, schema differences, mutable remote records, unrecoverable history, and privacy exclusions.

`ai data repair` is a dry run. `--apply` may append an overlay only when the relationship is unique, the evidence is complete and non-sensitive, and its precondition is fixed. It never patches or deletes local tasks, GitHub comments, or snapshot objects. Repeating the same repair is a no-op.

Use `ai data export ... --repairs applied` to compose verified overlays with normalized records. The base snapshot remains unchanged.

## Scheduling, Backup, and Recovery

Run capture and verify periodically from cron or CI with a credential that has read-only repository access. Treat exit code `2` as an incomplete observation, not a successful baseline.

The default root is Git-ignored and is the local authoritative copy. Checksums detect damage but do not provide disaster recovery. Back up the directory independently with encryption and access controls, organize backup packages by year and month, and regularly restore a copy into a temporary repository before running `ai data verify`.
