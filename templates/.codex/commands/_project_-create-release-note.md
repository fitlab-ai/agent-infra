---
description: Auto-generate structured Release Notes from PRs/commits, optionally create GitHub Draft Release
argument-hint: <version> [prev-version]
---

Generate Release Notes for version $ARGUMENTS.

Automatically collect change information from PRs, commits, and Issues, classify by module and type, and generate structured Release Notes. Supports creating GitHub Draft Release.

Execute the following steps:

1. Parse arguments:
   - Extract from $ARGUMENTS: version (required) and prev-version (optional)
   - Must match X.Y.Z format
   - If invalid, error and exit

2. Determine version range:
   - Current tag: v<version>
   - If prev-version not specified, auto-detect from `git tag --sort=-v:refname`
   - Verify both tags exist

3. Collect merged PRs:
   ```bash
   git log v<prev-version> --format=%aI -1
   git log v<version> --format=%aI -1
   gh pr list --state merged --base <branch> --json number,title,body,author,labels,mergedAt,url --limit 200 --search "merged:YYYY-MM-DD..YYYY-MM-DD"
   ```
   Also collect direct commits without PRs:
   ```bash
   git log v<prev-version>..v<version> --format="%H %s" --no-merges
   ```

4. Collect related Issues:
   Extract from PR body: Closes #N, Fixes #N, Resolves #N (case-insensitive)
   ```bash
   gh issue view <N> --json number,title,labels,url
   ```

5. Classify by module:
   Priority: PR title tags [module] → conventional commit scope → file paths → default module

6. Classify by type:
   - feat/perf/refactor/chore(deps) → ✨ Enhancement
   - fix → ✅ Bugfix
   - docs → 📚 Documentation (merge into Enhancement if < 3 items)

7. Generate Release Notes:
   ```markdown
   ## {Platform/Module Name}

   ### ✨ Enhancement
   - [{scope}] Description by @author in [#N](url)

   ### ✅ Bugfix
   - [{scope}] Description by @author in [#N](url)

   ## ❤️ Contributors
   @contributor1, @contributor2
   ```
   Format rules:
   - Item: `- [module] Description by @author in [#N](url)`
   - Issue + PR: `in [#Issue](url) and [#PR](url)`
   - Description: PR title without type(scope): prefix, capitalize first letter
   - Contributors: deduplicated, sorted by count descending
   - Empty sections: omit

8. Present and confirm:
   Display complete release notes for user review.
   Ask whether to create GitHub Draft Release.

9. Create Draft Release (if confirmed):
   ```bash
   gh release create v<version> --title "v<version>" --notes-file /tmp/release-notes-v<version>.md --draft
   ```

**Error handling**:
- Invalid version format → prompt and exit
- Tag not found → prompt to create tag first (run /release)
- gh CLI not authenticated → prompt authentication
- No merged PRs → prompt to check tags and branches

**Notes**:
- Requires gh CLI installed and authenticated
- Tags must exist before running this command
- Draft mode: won't auto-publish, requires manual review on GitHub
