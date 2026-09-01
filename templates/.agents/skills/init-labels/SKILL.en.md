---
name: init-labels
description: >
  Initialize the repository's standard labels taxonomy.
  Use when setting up a repository and you need the standard label taxonomy created.
---

# Initialize labels

Initialize the repository's standard labels taxonomy.

## Execution Flow

### 1. Verify prerequisites

Confirm that:
- read `.agents/rules/label-milestone-setup.md` first
- the repository configuration and requested mapping are ready

If any prerequisite fails, stop and report the matching error.

### 2. Run the bootstrap script

Execute the complete label initialization flow with:

```bash
bash .agents/skills/init-labels/scripts/init-labels.sh
```

The script and `.agents/rules/label-milestone-setup.md` are responsible for:
- Reading the configured `labels.in` mapping and preserving unrelated labels
- Selecting the provider leaf or returning a clear no-op/degraded result
- Creating or updating the standard label set and reporting the final summary
- Printing the final execution summary

### 3. Standard taxonomy

The script manages these common label families:
- `type:` labels such as `type: bug`, `type: enhancement`, `type: feature`, `type: documentation`, `type: dependency-upgrade`, and `type: task`
- `status:` labels such as `status: waiting-for-triage`, `status: in-progress`, and `status: waiting-for-internal-feedback`
- platform-default-name labels intentionally overwritten in place: `good first issue` and `help wanted`
- Additional shared labels such as `dependencies`

#### Scope

| Label prefix | Issue | PR | Notes |
|---|---|---|---|
| `type:` | — | Yes | Issues use the native platform Type field; PRs need `type:` labels to drive changelog grouping |
| `status:` | Yes | — | PRs already have their own state flow (Open/Draft/Merged/Closed); Issues use `status:` labels for project tracking |
| `in:` | Yes | Yes | Both Issues and PRs need module-based filtering |

### 4. Configure the `in:` Label Mapping

Check whether `.agents/.airc.json` already contains a `labels.in` field.

#### 4.1 Existing mapping

Show the current mapping and ask whether it should be updated.
- if no: continue to step 4.3
- if yes: continue to step 4.2

#### 4.2 Missing mapping or user-requested update

1. Scan top-level project directories while excluding hidden and generated folders.
2. Analyze the directory contents and suggest meaningful module groupings.
3. Show the proposed `in:` label mapping and refine it through the user's natural-language feedback.
4. If the user declines configuration, generate a 1:1 fallback mapping for each top-level directory (`{dir}/`).

#### 4.3 Write the mapping and create labels

1. Write the final mapping to `.agents/.airc.json` under `labels.in`.
2. Run `bash .agents/skills/init-labels/scripts/init-labels.sh` to create or update one `in: {key}` label for each mapping key.
3. After user confirmation, rerun the script with `--cleanup-stale-in` to delete stale `in:` labels that are no longer present in the final mapping.

### 5. Output and behavior guarantees

The summary must include:
- Number of common labels created or updated
- The written `labels.in` mapping
- The number of `in:` labels derived from the mapping keys
- Confirmation that exact-match platform defaults were overwritten
- Any unmatched platform-default labels still present

Operational notes:
- The operation is idempotent because the provider leaf updates or overwrites existing labels in place.
- `in:` labels are managed by the AI-guided step together with the `.airc.json` mapping.

### 6. Inform User

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

After summarizing the label initialization, show:

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill init-milestones`.

```
Next step - initialize milestones (optional):
{next-step-commands}
```

## Error Handling

- Provider capability unavailable: report the script's `degraded` or `no-op` result without claiming remote changes.
- Provider authentication or repository access failure: report the script's non-zero exit status and diagnostic output; do not claim remote changes.
- Permission error: prompt "No permission to manage labels in this repository"
- API rate limit: prompt "platform API rate limit reached, please retry later"
