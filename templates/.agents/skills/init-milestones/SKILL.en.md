---
name: init-milestones
description: >
  Initialize the repository's standard milestones taxonomy.
  Use when setting up a repository and you need the standard milestone taxonomy created.
---

# Initialize milestones

Initialize the repository's standard milestones taxonomy.

## Execution Flow

### 1. Verify prerequisites

Confirm that:
- read `.agents/rules/label-milestone-setup.md` first
- the requested milestone arguments are ready

If any prerequisite fails, stop and report the matching error.

### 2. Run the milestones runtime intent

Execute the complete milestone initialization flow with:

```bash
agent-infra-internal platform-metadata init-milestones $ARGUMENTS
```

The runtime intent and `.agents/rules/label-milestone-setup.md` are responsible for:
- Receiving the `--history` request and planning the desired milestones
- Applying the established baseline, history, state, and title-idempotency contract
- Letting runtime/provider code list and write current milestones
- Printing the final execution summary

### 3. Standard milestone definitions

Create the following milestones with fixed descriptions:
- `General Backlog`: `All unsorted backlogged tasks may be completed in a future version.` (state=`open`)
- `{major}.{minor}.x`: `Issues that we want to resolve in {major}.{minor} line.` (state=`open`)
- Release version: use compatibility baseline `0.1.0` for the default source, or `{major}.{minor}.{patch+1}` for a valid tag source. The description is `Issues that we want to release in v{version}.` (state=`open`)

When `--history` is present, each historical `vX.Y.Z` tag additionally contributes:
- `X.Y.x` as an open line milestone
- `X.Y.Z` as a closed release milestone (`state=closed`)

### 4. Output and behavior guarantees

The summary must include:
- Version baseline
- Version baseline source
- Whether `--history` was enabled
- Created and skipped milestone counts
- Newly created milestone titles
- Already present milestone titles

Operational notes:
- Milestone titles are treated as the idempotency key.
- General Backlog is the fallback milestone for unsorted work.
- Without `--history`, create one standard release milestone: compatibility baseline `0.1.0` for the default source, or the next patch version for a valid tag source.
- Historical `X.Y.Z` tags create `X.Y.x` milestones as open and `X.Y.Z` milestones as closed.
- Repositories with many tags may hit the platform API rate limit.

### 5. Inform User

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

After summarizing the milestone initialization, show:

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill init-labels`.

```
Next step - initialize labels (optional):
{next-step-commands}
```

## Error Handling

- Platform capability, authentication, or repository access failure: report the runtime's non-zero exit status and diagnostic output; do not claim remote changes.
- Version detection failed: report the runtime's version-baseline error
- No valid SemVer `v*` tags found in `--history` mode: report the runtime's history diagnostic
- Permission error: prompt "No permission to manage milestones in this repository"
- API rate limit: prompt "platform API rate limit reached, please retry later"
