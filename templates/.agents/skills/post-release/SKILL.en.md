---
name: post-release
description: "Run post-release follow-up tasks"
---

# Post-release Tasks

Run the standard follow-up workflow after a release tag has been pushed.

## Execution Flow

### 1. Detect the Latest Released Version

```bash
git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1
```

- Detect the latest `vX.Y.Z` tag, then strip the `v` prefix when you need the version number in later steps
- If no tag is found, error: "No released version tag found. Please create and push a release tag first."

### 2. Verify Clean Workspace

```bash
git status --short
```

- If there are uncommitted changes, error: "Workspace has uncommitted changes. Please commit or stash first."

### 3. Prepare the Next Development Version

<!-- TODO: Replace this step with your project's version bump command -->

```bash
# TODO: Replace with your project's post-release version bump command
# npm version prerelease --preid=alpha --no-git-tag-version
```

- Update lockfiles or generated version metadata if your project needs them
- Keep all version references in sync after the bump

### 4. Rebuild Generated Artifacts

<!-- TODO: Replace this step with your project's rebuild command -->

```bash
# TODO: Replace with your project's artifact rebuild command
```

- Rebuild any generated files, embedded assets, or inline templates affected by the new version
- If your project has no generated artifacts, remove this step in the project-specific copy

### 5. Run Other Post-release Tasks (Optional)

<!-- TODO: Add project-specific follow-up tasks such as demo capture, docs publishing, or downstream notifications -->

- Examples: record a terminal demo, refresh a docs site, notify downstream teams, update release dashboards
- If there are no extra tasks, remove this step in the project-specific copy

### 6. Create the Follow-up Commit

```bash
git add -A
git commit -m "chore: prepare next dev iteration after v{released-version}"
```

### 7. Output Summary

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

```
Post-release tasks completed.

Summary:
- Released version: {released-version}
- Next development version: {new-version}
- Extra tasks completed: {summary}

Next step (manual):
- Push branch: git push origin {current-branch}
```

## Notes

1. **No arguments**: Detect the released version from the latest tag instead of asking the user to repeat it
2. **Clean workspace required**: Avoid mixing unrelated edits into the post-release commit
3. **Project-specific customization**: Replace the TODO steps with the commands your project actually needs
4. **Local-only workflow**: This skill prepares local changes and does not push automatically

## Error Handling

- No release tag found: Prompt the user to finish the release first
- Dirty workspace: Prompt the user to commit or stash changes
- Version bump failed: Display the command error and stop
- Artifact rebuild failed: Display the build error and stop
- Git commit failed: Display the error and leave the workspace intact for manual recovery
