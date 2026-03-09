---
name: "release"
description: "Execute version release workflow"
usage: "/release <version>"
---

# Release Command

## Description

Execute the standardized version release workflow. Argument: $ARGUMENTS (X.Y.Z format).

<!-- TODO: Adapt the steps below to your project's release process -->

## Execution Steps

### Step 1: Parse and Validate Version

Extract version from `$ARGUMENTS`. Must match `X.Y.Z` format.

**Parse version components**:
- MAJOR = X, MINOR = Y, PATCH = Z
- Release version = `X.Y.Z`

If format is invalid, error: "Version format incorrect, expected X.Y.Z (e.g., 1.2.3)"

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
# Grep for current version pattern
# Update using Edit tool
```

**Common files to update**:
- `package.json` (Node.js)
- `pom.xml` (Maven)
- `setup.py` / `pyproject.toml` (Python)
- `version.go` (Go)
- `README.md` (documentation)

**Directories to exclude** (AI tool configs, should not be affected by version replacement):
- `.agents/`, `.ai-workspace/`, `.claude/`, `.codex/`, `.gemini/`, `.opencode/`

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
   - Claude Code / OpenCode: `/create-release-note {version}`
   - Gemini CLI: `/{project}:create-release-note {version}`
   - Codex CLI: `/prompts:{project}-create-release-note {version}`
```

## Usage Example

```bash
/release 1.2.3
```

## Rollback

If something went wrong during release:

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
3. **No build verification**: Run `/test` before releasing to verify
4. **Version replacement scope**: Grep determines which files to update; exclude AI tool config directories
5. **Adapt to your project**: The version update steps above are generic; customize for your project's versioning scheme

## Error Handling

- Invalid version format: Prompt correct format and exit
- Dirty workspace: Prompt to commit or stash
- Git operation failure: Display error and provide rollback instructions

## Related Commands

- `/create-release-note <version>` - Generate Release Notes
- `/commit` - Commit code
- `/test` - Run tests
