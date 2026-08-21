# Process Data Archive

`ai data` records GitHub process evidence as append-only, verified snapshots. The new capture path is GitHub-only: local task files, Activity Logs, and receipts are already normalized locally and are not collected by this command.

## Commands

```bash
ai data capture [--source github] [--root <dir>] [--full-reconcile]
ai data verify <snapshot-id> [--root <dir>]
ai data audit <snapshot-id> [--root <dir>] [--format json|text]
ai data repair <snapshot-id> [--root <dir>] [--apply]
ai data export <snapshot-id> [--root <dir>] [--as-of <ISO>] [--repairs none|applied] [--output <file|->]
```

`--source github` is the default. `--source local`, `--source all`, and `--include-excerpts` fail closed; they do not create a data root, checkpoint, or snapshot. Existing `raw-manifest/v1` local, all, and GitHub snapshots remain readable by `verify`, `audit`, `repair`, and `export`.

## Observation and lineage

The first successful capture is a `base` snapshot. Later captures are `delta` snapshots linked through one parent and a checkpoint at `checkpoints/github/`. A checkpoint advances only after CAS writes, snapshot publication, and verification succeed.

Each run performs a GitHub response-date preflight and records an observation cutoff `F`. For endpoints with a documented strict `since` parameter, an incremental run requests `W - 1 second` and accepts objects in `[W, F)`. The one-second reread closes the inclusive checkpoint boundary. Objects older than `W` are overlap evidence; objects at or after `F` are deferred to a later observation. Endpoints without a documented `since` contract, including issue timelines, are fully paginated.

HTTP `Date`, page evidence, and the checkpoint prove the observed request and local lineage only. They do not claim that GitHub has exposed every historical object by `F`. Use `--full-reconcile` to enumerate all endpoints without `since` and correct delayed visibility. Scheduling repeated full reconciliation is outside this task.

## Storage and verification

```text
process-data/
  objects/sha256/<prefix>/<digest>
  snapshots/YYYY/MM/DD/<snapshot-id>/
  checkpoints/github/<repository-key>.json
  repairs/<snapshot-id>/<repair-id>/
  .staging/
```

Page evidence and resource objects are separate CAS entries. Page hashes prove pagination and request metadata; resource hashes are the only hashes used for stable delta equality. Resource identities do not contain page numbers. Issues, pull requests, comments, reviews, commits, and timeline events are projected through an allowlist.

`verify` checks manifest hashes, lineage, observation-window arithmetic, query evidence, operation counts, normalized records, and CAS objects. It never upgrades an HTTP `Date` into a completeness proof. `export --as-of` materializes only a verified v2 lineage whose observation watermark is no later than the requested time.

## Privacy, recovery, and repair

Sensitive GitHub text is excluded by policy and is never restored by repair. Network, permission, identity, missing-time, response-boundary, and pagination failures stop the run before checkpoint advancement. Checkpoint locks are single-writer, host-bound, and owner-specific; unknown ownership or ambiguous recovery fails closed.

`ai data repair` remains append-only and does not delete source records or snapshots. `--apply` writes a verified overlay only when its precondition is fixed. Historical v1 overlays continue to work without rewriting v1 data.
