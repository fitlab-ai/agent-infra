---
name: init-labels
description: "Initialize the repository's standard GitHub Labels taxonomy"
---

# Initialize GitHub Labels

Initialize the repository's standard GitHub Labels taxonomy.

## Execution Flow

### 1. Verify prerequisites

Confirm that:
- `gh` is installed
- `gh auth token` succeeds
- `gh repo view --json nameWithOwner` can access the current repository

If any prerequisite fails, stop and report the matching error.

### 2. Run the bootstrap script

Execute the complete label initialization flow with:

```bash
bash .agents/skills/init-labels/scripts/init-labels.sh
```

The script is responsible for:
- Capturing the current label snapshot before making changes
- Creating or updating the standard label set with `gh label create --force`
- Reporting unmatched GitHub default labels such as `question` and `wontfix`
- Printing the final execution summary

### 3. Standard taxonomy

The script manages these common label families:
- `type:` labels such as `type: bug`, `type: enhancement`, `type: feature`, `type: documentation`, `type: dependency-upgrade`, and `type: task`
- `status:` labels such as `status: waiting-for-triage`, `status: in-progress`, and `status: waiting-for-internal-feedback`
- GitHub-default-name labels intentionally overwritten in place: `good first issue` and `help wanted`
- Additional shared labels such as `dependencies`

#### Scope

| Label prefix | Issue | PR | Notes |
|---|---|---|---|
| `type:` | — | Yes | Issues use the native GitHub Type field; PRs need `type:` labels to drive changelog grouping |
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
2. Create one `in: {key}` label for each mapping key:
   ```bash
   gh label create "in: {key}" --color EBF8DF --description "Module: {key}" --force
   ```
3. After user confirmation, delete stale `in:` labels that are no longer present in the final mapping.

### 5. Output and behavior guarantees

The summary must include:
- Number of common labels created or updated
- The written `labels.in` mapping
- The number of `in:` labels derived from the mapping keys
- Confirmation that exact-match GitHub defaults were overwritten
- Any unmatched GitHub default labels still present

Operational notes:
- The operation is idempotent because every label uses `gh label create --force`.
- `in:` labels are managed by the AI-guided step together with the `.airc.json` mapping.

### 6. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

After summarizing the label initialization, show:

```
Next step - initialize milestones (optional):
  - Claude Code / OpenCode: /init-milestones
  - Gemini CLI: /{{project}}:init-milestones
  - Codex CLI: $init-milestones
```

## Error Handling

- `gh` not found: prompt "GitHub CLI (`gh`) is not installed"
- Authentication failed: prompt "GitHub CLI is not authenticated"
- Repository access failed: prompt "Unable to access the current repository with gh"
- Permission error: prompt "No permission to manage labels in this repository"
- API rate limit: prompt "GitHub API rate limit reached, please retry later"
