---
name: review-pr
description: >
  Review a pull request by evidence grade and publish a formal PR review.
  Use when a PR needs review (regardless of whether trusted lifecycle records exist).
  Only invoke this skill automatically when the conversation includes a resolvable PR number or PR URL.
---

# Review Pull Request

Based on the target PR's lifecycle-evidence completeness and change risk, select `verify` (lightweight recheck), `audit` (evidence audit), or `reconstruct` (reconstruction review), publish the actionable review conclusion as a formal PR Review on the target PR, and retain traceable review-process evidence (`pr-review.md` / `pr-review-r{N}.md`).

## Boundary / Critical Rules

### Persisted Report Evidence

Before generating the PR review report, read `.agents/rules/evidence-reporting.md`. Normal review records the command, scope, structured result, actual conclusion, and uncovered parts; formal Review, findings, blocking conditions, or disputes retain exact identity fields and decisive evidence.

- Strictly follow the fixed evidence-grading decision flow: host resolution → evidence classification → freshness/alignment → risk grading → mode selection
- `pr-review*` is an independent artifact family: it does not join the analysis/plan/code stage chain and never changes `current_step`
- Only a formal PR Review (head SHA, conclusion, findings, receipt, Issue artifact link) is published on the PR; no second full process copy goes to a regular PR comment
- The full process copy and the reversible `task.md` mirror are synced only to the linked Issue; `restore-task` keeps its Issue-only contract
- Before generating artifact Markdown that will be synced to an Issue, read `.agents/rules/sync-content-generation.md` and follow its generator-side constraints; Issue sync remains transparent and does not parse or rewrite the body
- Never backfill or fabricate `analysis`/`plan`/`code` lifecycle history for an external PR
- The head SHA is recorded only in `pr-review*` and the formal PR Review; on head drift you must start a new round and never reuse an old conclusion
- Review depth is driven by evidence completeness and change risk, never by the submitter's identity
- After executing this skill you **must** immediately update task.md (via the `task-activity` typed intent)
- Never run `git add` or `git commit` automatically
- The one-shot path (no task/Issue) uses `.agents/workspace/reviews/{pr-number}/` with `recoverable: false` and carries no recovery promise

## Common Rationalizations and Rebuttals

| Rationalization | Rebuttal |
|-----------------|----------|
| "Just read the diff; no reconstruction needed" | Reading only the diff misses requirement boundaries, architecture choices, and migration strategy; `reconstruct` must first produce the minimum-sufficient reconstruction record. |
| "The PR has no linked task; just post a report" | Block by default and require linking an Issue/task first; only an explicit "one-shot review" takes the non-recoverable fallback path. |
| "Also post the full reconstruction to a regular PR comment for contributors" | The process copy is synced only to the Issue artifact comment; the PR keeps only the formal Review to avoid duplicate remote copies and restore-source confusion. |
| "Commit while I'm at it" | This skill never runs `git add`/`git commit`; committing is a separate, explicitly user-triggered step. |

## Step 0: State Check (pre-execution hard gate)

Before making any task-state judgment or user-visible conclusion, run the state check:

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

The task-anchored path records the current task directory and existing `pr-review*` rounds before starting; the one-shot path (no task) records the PR number and target directory. Record the command, PR/head, review scope, key result, and uncovered parts in this round's `## State Check` section; do not paste complete directory listings or task tails on normal success, and retain decisive raw lines for identity mismatches, failures, blocking conditions, or disputes.

## Steps

### 1. Resolve the Input and the Host

Resolve the target PR number `{pr-number}` (`--pr <number>`, a PR URL, or by reverse lookup from the current branch). Run:

```bash
agent-infra-internal platform-pr-review inspect --pr {pr-number} [--cwd <path>]
agent-infra-internal pr-review-grade resolve-host --pr {pr-number} [--cwd <path>]
```

`resolve-host` returns a typed `HostResolution` (`unique` / `ambiguous` / `none`). Branch as follows:

- **Unique host**: bind `{task-id}`, call `task-activity pr-review-inspect` to obtain the canonical round, prepared/open state, and latest successful review identity, then start this round using the recovery rules below (go to step 2).
- **Ambiguous hosts**: `resolve-host` returns `ambiguous` and `decide` refuses to classify (fail closed). Stop and ask a human to pin the unique host; do not enter evidence classification.
- **No host**: block by default and require linking an Issue/task first (show linking guidance); never auto-create/import an Issue. Only when the user explicitly chooses a "one-shot review" do process files land in `.agents/workspace/reviews/{pr-number}/` (`recoverable: false`).

After the task-anchored path resolves the host and remote head, run:

```bash
agent-infra-internal task-activity {task-id} pr-review-inspect
```

- `prepared`: reuse that artifact; `open` with an unchanged head: replay start for the same artifact/head (a no-op) and resume the round.
- `open` with a changed head: first set the old artifact Formal Review Status to `superseded`, then terminate it using the old artifact/head; continue with the next round returned by inspect.
- No prepared/open round: create the next artifact skeleton from `reference/report-template.md`, initially recording the state check, identity, reviewed head, and `Formal Review Status: pending`.

After this branch and before step 2 evidence grading, write started:

```bash
agent-infra-internal task-activity {task-id} pr-review-start --agent {agent} \
  --artifact {pr-review-artifact} --head {head-sha}
```

The one-shot path never calls `task-activity`. For a controlled failure after started where the formal Review is known not to have been published, first set the artifact status to `aborted`, then call `pr-review-terminate --outcome aborted --reason <single-line>` with the same artifact/head. If publication outcome is uncertain, leave the round open rather than guessing aborted.

### 2. Single decide: evidence enumeration + classification + risk + mode

Write the host, artifact presence, head state, and the six pure-evidence risk factors to an input JSON. Use only the highest `applied` / `no-op` artifact returned by inspect as the prior review; pending/aborted/superseded/failed artifacts count only toward round continuity. Then call once:

```bash
agent-infra-internal pr-review-grade decide --input-file {decide-input.json} [--cwd <path>]
```

Returns the full `DecisionRecord` (`scenario` / `freshness` / `alignment` / `risk` / `mode` / `firstReview` / `reason`) in one call. Record the decision input and output verbatim in the `pr-review-rN.md` "Evidence List" section (AC3 traceability). When `host.kind === 'ambiguous'`, the command refuses; return to step 1's blocking exit.

### 3. Generate `pr-review-rN.md`

Complete this round's artifact per `reference/report-template.md`; the task-anchored path preserves the identity/head/pending status written in step 1 and does not reallocate the round. In `reconstruct` mode (or `audit` with insufficient evidence), write a "Reconstruction Context" section (requirement boundary / architecture choices / impact surface / validation coverage, see `reference/evidence-grading.md`) before the line-level findings. Record `recoverable: true|false` in the frontmatter or header (the one-shot path sets `false`). After finalizing the findings list, freeze `{verdict, blockers, major, minor}` once; the formal Review body and step 6 complete payload must consume that same object directly, never recounting report prose.

### 4. Sync the Issue artifact comments (task-anchored path)

Sync the task comment, then the artifact comment, and capture a stable comment URL:

```bash
agent-infra-internal platform-comment sync {task-id} --kind task --agent {agent}
agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {pr-review-artifact} --agent {agent}
```

The one-shot path (no task/Issue) skips this step.

### 5. Recheck the head and publish the formal Review

Read the remote head again to confirm it did not drift during the review:

```bash
agent-infra-internal platform-pr-review inspect --pr {pr-number} [--cwd <path>]
```

If the head matches step 1, assemble the body (head SHA / conclusion / findings / receipt / Issue artifact link, **without a marker**) and publish the formal Review:

```bash
agent-infra-internal platform-pr-review publish --pr {pr-number} --scope {taskId|pr{pr-number}} --round {round} \
  --commit {head-sha} --event {COMMENT|APPROVE|REQUEST_CHANGES} --body-file {review-body.md} [--dry-run] [--cwd <path>]
```

`publish` generates and validates the marker (first line) in core and is idempotent per marker + commit (replay is a no-op; marker hit on a different commit fails stably). On head drift, first set the old artifact status to `superseded`, then close the old round:

```bash
agent-infra-internal task-activity {task-id} pr-review-terminate --agent {agent} \
  --artifact {pr-review-artifact} --head {head-sha} \
  --outcome superseded --reason "head changed before publish"
```

After closure, re-run step 1 for the next canonical round; never start the new round first. If the remote outcome of `publish` is uncertain, keep the round open and recover through marker + commit idempotency on retry.

### 6. Write back the publication result and task state

- **Task-anchored path**: after publish returns `applied` / `no-op`, write the Review ID/URL and matching Formal Review Status into the `pr-review-rN.md` "Publication Result" section, then close the Activity Log with the exact verdict/counts frozen in step 3:

  ```bash
  agent-infra-internal task-activity {task-id} pr-review-complete --agent {agent} \
    --artifact {pr-review-artifact} --head {head-sha} --verdict {approved|changes-requested|commented} \
    --blockers {blockers} --major {major} --minor {minor}
  ```

  `task-activity` generates `Verdict: <result>, blockers: N, major: N, minor: N → {pr-review-artifact}` from the typed payload and atomically writes the Activity Log, `## Review Feedback` link, and version stamp through `writeTask`. It never changes `current_step` or puts receipt/head/Review URL into the NOTE.

- **One-shot path (no task)**: write the Review ID/URL only into the `pr-review-rN.md` "Publication Result" section; do not call `task-activity`.

### 7. Re-sync after write-back (task-anchored path)

Step 6 rewrote the local `pr-review-rN.md` "Publication Result" section and task.md (Activity Log), while step 4 synced the older snapshot. `verify_comment_content` / `verify_task_comment_content` compare full content, so you must re-sync first to align local and remote. Run in order:

```bash
agent-infra-internal platform-comment sync {task-id} --kind task --agent {agent}
agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {pr-review-artifact} --agent {agent}
```

`platform-comment sync` updates an existing marker comment in place (idempotent), so the comment URL is unchanged. The one-shot path has no task and skips this step.

### 8. Run the completion verification

- **Task-anchored path**:

  ```bash
  agent-infra-internal task-verify {task-id} review-pr.completed --artifact {pr-review-artifact} --format text
  ```

- **One-shot path**:

  ```bash
  agent-infra-internal pr-review-grade verify-artifact --artifact-file {pr-review-artifact} [--cwd <path>]
  ```

Exit code 0 passes; 1 means fix per the output and re-run; 2 means stop and ask for human intervention.

### 9. Inform the user

Pick the single exit branch per `reference/output-guidance.md` (published / blocked-requires-link / one-shot), and read `.agents/rules/next-step-output.md` before rendering the next step.

## Completion Checklist

- [ ] Completed the evidence-graded PR review and produced `pr-review-rN.md`
- [ ] Published the formal Review on the target PR, bound to the reviewed head SHA
- [ ] Synced and re-synced the Issue artifact/task comments on the task-anchored path
- [ ] Ran the completion verification (`task-verify` or `verify-artifact`)
- [ ] Updated task.md and appended the Activity Log entry (task-anchored path)

## Stop

Stop as soon as the checklist is complete. Do not commit automatically.
