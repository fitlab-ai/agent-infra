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
- Auto-detecting top-level directories and creating one `in:` label per valid directory
- Falling back to `in: core` when no eligible directory is detected
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

### 4. Scope discovery rules

Directory-derived labels follow these rules:
- Detect top-level project directories only
- Skip hidden directories and common generated folders
- Create `in: core` only when no valid directory remains
- Do not create any `theme:` labels in this skill

### 5. Output and behavior guarantees

The summary must include:
- Number of common labels created or updated
- Number of `in:` labels created or updated
- Confirmation that exact-match GitHub defaults were overwritten
- Any unmatched GitHub default labels still present

Operational notes:
- The operation is idempotent because every label uses `gh label create --force`.
- If the detected `in:` labels need refinement, adjust them manually after initialization.

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
