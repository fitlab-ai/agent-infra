---
name: release
description: >
  Execute the version release workflow. Triggered when the user
  requests a version release. Argument: version number (X.Y.Z).
---

# Version Release

Execute the version release workflow for the specified version.

<!-- TODO: Adapt the steps below to your project's release process -->

## Execution Flow

### Step 1: Parse and Validate Version

Extract version from arguments. Must match `X.Y.Z` format.

Parse components:
- MAJOR = X, MINOR = Y, PATCH = Z
- Release version = `X.Y.Z`

If format is invalid, error: "Version format incorrect, expected X.Y.Z (e.g. 1.2.3)"

### Step 2: Verify Clean Workspace

```bash
git status --short
```

If there are uncommitted changes, error: "Workspace has uncommitted changes. Please commit or stash first."

### Step 3: Update Version References

<!-- TODO: Replace with your project's version update steps -->

Search for version references in project files and update them:

```bash
# Find files with version references
# Search for current version pattern
# Update version strings
```

**Common files to update**:
- `package.json` (Node.js)
- `pom.xml` (Maven)
- `setup.py` / `pyproject.toml` (Python)
- `version.go` (Go)
- `README.md` (documentation)
- `SECURITY.md` / `SECURITY.zh-CN.md` (supported version table)

**Exclude from version replacement**:
- `.agents/`, `.ai-workspace/`, `.claude/`, `.codex/`, `.gemini/`, `.opencode/` (AI tool configs)

### Step 4: Create Release Commit

```bash
git add -A
git commit -m "chore: release v{version}"
```

### Step 5: Create Git Tag

```bash
git tag v{version}
```

### Step 6: Output Summary

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

```
Release v{version} prepared.

Release info:
- Version: {version}
- Release commit: {commit-hash}
- Tag: v{version}

Files updated: {count}

Next steps (manual):

1. Push tag:
   git push origin v{version}

2. Push branch:
   git push origin {current-branch}

3. (Optional) Generate release notes:
   - Claude Code / OpenCode: /create-release-note {version}
   - Gemini CLI: /{{project}}:create-release-note {version}
   - Codex CLI: $create-release-note {version}
```

### Rollback Instructions

If something went wrong:
```bash
# Delete tag
git tag -d v{version}

# Reset commit
git reset --soft HEAD~1

# Restore files
git checkout -- .
```

## Notes

1. **Clean workspace required**: Must have no uncommitted changes
2. **No auto-push**: All operations are local only; user pushes manually
3. **No build verification**: Run the test skill before releasing to verify
4. **Version replacement scope**: Search determines which files to update; exclude AI tool directories
5. **Adapt to your project**: The version update steps above are generic; customize for your project's versioning scheme

## Error Handling

- Invalid version format: Prompt correct format and exit
- Dirty workspace: Prompt to commit or stash
- Git operation failure: Display error and provide rollback instructions
