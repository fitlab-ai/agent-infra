---
description: Execute version release workflow
argument-hint: <version>
---

Execute the standardized version release workflow for version $ARGUMENTS.

<!-- TODO: Adapt to your project's release process -->

**No build verification**: Only version updates and Git operations.
**No auto-push**: All operations are local; user pushes manually.

Execute the following steps:

1. Parse and validate arguments:
   - Version = $ARGUMENTS, must match X.Y.Z format
   - If invalid, error and exit

2. Verify clean workspace:
   ```bash
   git status --short
   ```
   If there are uncommitted changes, error and exit.

3. Update version references:
   <!-- TODO: Replace with your project's version update steps -->
   - Search for version references in project files and update them
   - Common files: pom.xml, package.json, README.md, setup.py, version.go
   - **Exclude directories**: .agents/, .ai-workspace/, .claude/, .codex/, .gemini/, .opencode/
   - Verify no references were missed

4. Create Release commit:
   ```bash
   git add -A && git commit -m "chore: release v{version}"
   ```

5. Create tag:
   ```bash
   git tag v{version}
   ```

6. Output summary:
   - Release version, commit hash, tag
   - Number of files updated
   - Manual post-steps:
     * git push origin v{version}
     * git push origin <current-branch>
     * (Optional) Generate Release Notes:
       - Claude Code / OpenCode: /create-release-note {version}
       - Gemini CLI: /{project}:create-release-note {version}
       - Codex CLI: /prompts:{project}-create-release-note {version}

**Error handling**:
- Invalid version format → prompt correct format
- Dirty workspace → prompt to commit or stash
- Git operation failure → show error, suggest manual handling

**Rollback**:
```bash
git tag -d v{version}
git reset --soft HEAD~1
git checkout -- .
```

**Notes**:
- Workspace must be clean
- No auto-push, all operations are local
- Run tests before releasing
- Adapt version update steps to your project
