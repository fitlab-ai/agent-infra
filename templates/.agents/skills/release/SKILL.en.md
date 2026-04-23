---
name: release
description: "Run the version release workflow"
---

# Version Release

Execute the version release workflow for the specified version.

<!-- TODO: Adapt the steps below to your project's release process -->

## Execution Flow

### 1. Parse and Validate Version

Extract version from arguments. Must match `X.Y.Z` format.

Parse components:
- MAJOR = X, MINOR = Y, PATCH = Z
- Release version = `X.Y.Z`

If format is invalid, error: "Version format incorrect, expected X.Y.Z (e.g. 1.2.3)"

### 2. Verify Clean Workspace

```bash
git status --short
```

If there are uncommitted changes, error: "Workspace has uncommitted changes. Please commit or stash first."

### 3. Pre-release Verification

<!-- TODO: Replace with your project's pre-release verification steps -->

Run any checks that must pass before preparing a release:

```bash
git branch --show-current
# TODO: Replace with your project's test/build verification commands
```

Verification guidance:
- Confirm the release is being prepared from the correct branch for your project
- Run the full validation commands required by your release process

Handling rules:
- If the current branch is unexpected, print a warning or exit based on your policy
- If any verification command fails, stop the release process and fix the issue first

### 4. Update Version References

<!-- TODO: Replace with your project's version update steps -->

Search for version references in project files and update them:

```bash
# Find files with version references
# Search for current version pattern
# Update version strings
```

**Common files to update**:
- `package.json` (Node.js)
- `package-lock.json` (Node.js; run `npm install --package-lock-only` after updating `package.json`)
- `pom.xml` (Maven)
- `setup.py` / `pyproject.toml` (Python)
- `version.go` (Go)
- `README.md` (documentation)
- `SECURITY.md` / `SECURITY.zh-CN.md` (supported version table)

**Exclude from version replacement**:
- `.agents/`, `.agents/workspace/`, `.claude/`, `.codex/`, `.gemini/`, `.opencode/` (AI tool configs)

If the project uses `package-lock.json`, run `npm install --package-lock-only` after updating `package.json` so the lockfile version stays in sync.

### 5. Rebuild Artifacts

<!-- TODO: Replace with your project's artifact rebuild steps -->

If version updates affect generated files, embedded metadata, or bundled assets, rebuild them now:

```bash
# TODO: Replace with your project's rebuild command(s)
```

Execution guidance:
- Run this after updating version references so generated artifacts pick up the new version
- If your project has no generated artifacts, document that explicitly in the project-specific skill
- If the rebuild fails, stop the release process and fix the build first

### 6. Create Release Commit

```bash
git add -A
git commit -m "chore: release v{version}"
```

### 7. Create Git Tag

```bash
git tag v{version}
```

### 8. Manage Milestones

Close the milestone for the released version when it exists, and create the missing planning milestones for the next cycle.

Run:

```bash
bash .agents/skills/release/scripts/manage-milestones.sh "$MAJOR" "$MINOR" "$PATCH"
```

The script is responsible for:
- Read `.agents/rules/label-milestone-setup.md` before this step
- Use its milestone list and update commands to load and adjust current milestones
- Closing `{MAJOR}.{MINOR}.{PATCH}` when it exists and is still open
- Ensuring `{MAJOR}.{MINOR}.{PATCH+1}` and `{MAJOR}.{MINOR}.x` exist
- When `PATCH=0`, also ensuring `{MAJOR}.{MINOR+1}.0` and `{MAJOR}.{MINOR+1}.x`
- Printing a milestone summary with the released milestone action and new milestone count

### 9. Output Summary

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures `customTools`, read each tool's `name` and `invoke`, then add the matching command line in the same format (`{name}` becomes the skill name and `&#123;project&#125;` becomes the project name).

```
Release v{version} prepared.

Release info:
- Version: {version}
- Release commit: {commit-hash}
- Tag: v{version}

Files updated: {count}

Next steps (manual):

1. Push branch:
   git push origin {current-branch}

2. Push tag:
   git push origin v{version}

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
3. **Pre-release verification**: Replace the Step 3 TODOs with the branch, test, and validation commands your release process requires
4. **Generated artifacts**: Replace the Step 5 TODOs when version changes affect generated files, bundled assets, or embedded metadata
5. **Release automation**: If pushing a tag triggers CI/CD or package publishing, confirm the required credentials and pipeline settings first
6. **Version replacement scope**: Search determines which files to update; exclude AI tool directories
7. **Adapt to your project**: The version update and rebuild steps above are generic; customize them for your project's versioning scheme
8. **Milestone coordination**: Releases should create the next planning milestones automatically; initialize the taxonomy first with `init-milestones` when needed

## Error Handling

- Invalid version format: Prompt correct format and exit
- Dirty workspace: Prompt to commit or stash
- Verification failure: Display the failing check and stop the release
- Artifact rebuild failure: Display the build error and stop the release
- Git operation failure: Display error and provide rollback instructions
