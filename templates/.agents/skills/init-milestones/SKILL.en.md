---
name: init-milestones
description: "Initialize the repository's standard GitHub Milestones taxonomy"
---

# Initialize GitHub Milestones

Initialize the repository's standard GitHub Milestones taxonomy.

## Execution Flow

### 1. Verify prerequisites

Confirm that:
- read `.agents/rules/label-milestone-setup.md` first
- use its authentication commands to verify platform access

If any prerequisite fails, stop and report the matching error.

### 2. Run the bootstrap script

Execute the complete milestone initialization flow with:

```bash
bash .agents/skills/init-milestones/scripts/init-milestones.sh "$ARGUMENTS"
```

The script and `.agents/rules/label-milestone-setup.md` are responsible for:
- Creating and cleaning up a temporary workspace
- Detecting whether `--history` was requested
- Resolving the version baseline from the latest `v*` Git tag, then `package.json`, then defaulting to `0.1.0`
- Listing current milestones with the platform-specific milestone query command
- Building the desired milestone set and creating only the missing titles
- Printing the final execution summary

### 3. Standard milestone definitions

Create the following milestones with fixed descriptions:
- `General Backlog`: `All unsorted backlogged tasks may be completed in a future version.` (state=`open`)
- `{major}.{minor}.x`: `Issues that we want to resolve in {major}.{minor} line.` (state=`open`)
- `{major}.{minor}.{patch+1}`: `Issues that we want to release in v{major}.{minor}.{patch+1}.` (state=`open`)

When `--history` is present, each historical `vX.Y.Z` tag additionally contributes:
- `X.Y.x` as an open line milestone
- `X.Y.Z` as a closed release milestone (`state=closed`)

### 4. Output and behavior guarantees

The summary must include:
- Version baseline
- Whether `--history` was enabled
- Created and skipped milestone counts
- Newly created milestone titles
- Already present milestone titles

Operational notes:
- Milestone titles are treated as the idempotency key.
- General Backlog is the fallback milestone for unsorted work.
- Without `--history`, version milestones are created only for the next patch release.
- Historical `X.Y.Z` tags create `X.Y.x` milestones as open and `X.Y.Z` milestones as closed.
- Repositories with many tags may hit the platform API rate limit.

### 5. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures `customTools`, read each tool's `name` and `invoke`, then add the matching command line in the same format (`{name}` becomes the skill name and `&#123;project&#125;` becomes the project name).

After summarizing the milestone initialization, show:

```
Next step - initialize labels (optional):
  - Claude Code / OpenCode: /init-labels
  - Gemini CLI: /{{project}}:init-labels
  - Codex CLI: $init-labels
```

## Error Handling

- `gh` not found: prompt "GitHub CLI (`gh`) is not installed"
- Authentication failed: prompt "GitHub CLI is not authenticated"
- Repository access failed: prompt "Unable to access the current repository with gh"
- Version detection failed: prompt "Unable to determine current version baseline"
- No `v*` tags found in `--history` mode: prompt "No history tags found matching v*; only standard milestones will be created"
- Permission error: prompt "No permission to manage milestones in this repository"
- API rate limit: prompt "GitHub API rate limit reached, please retry later"
