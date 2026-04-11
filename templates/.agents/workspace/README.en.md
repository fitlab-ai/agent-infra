# AI Workspace

This directory is the runtime workspace for multi-AI collaboration. All contents are **git-ignored** except for this README and `.gitkeep` files.

## Directory Structure

```
.agents/workspace/
  active/           # Currently active tasks and handoff documents
  blocked/          # Tasks that are blocked and waiting for resolution
  completed/        # Completed tasks (kept for reference)
  logs/             # Collaboration logs and session records
```

## Usage

- **active/**: Place task files here when work begins. Move them to `completed/` or `blocked/` as appropriate.
- **blocked/**: Move tasks here when they cannot proceed. Document the blocker in the task file.
- **completed/**: Move tasks here when they are done. These serve as a historical record.
- **logs/**: Store session logs, AI conversation exports, or collaboration notes.

## Important

- Contents of this directory are **not version-controlled** (git-ignored).
- Do not store anything here that needs to be shared via git.
- Templates and workflow definitions belong in `.agents/`, not here.
