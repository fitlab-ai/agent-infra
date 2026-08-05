---
name: create-release-note
description: >
  Generate release notes from PRs and commits.
  Use when preparing a release and you need notes compiled from PRs and commits.
---

# Create Release Notes

Generate comprehensive release notes for a version based on merged PRs and commits.

## Execution Flow

### 1. Parse Arguments

From arguments:
- `<version>`: Current release version (required), format `X.Y.Z`
- `<prev-version>`: Previous version (optional), auto-detected if not provided

### 2. Determine Version Range

**Current tag**: `v<version>`

**Previous tag** (if not specified):
```bash
git tag --sort=-v:refname
```
Find the most recent tag before `v<version>`.

**Verify tags exist**:
```bash
git rev-parse v<version>
git rev-parse v<prev-version>
```

### 3. Reference Historical Release Notes Format and Categories

Load one typed release-note context, then use a predefined complete category list:

Read `.agents/rules/release-commands.md` before this step.

```bash
agent-infra-internal platform-release-notes context \
  --from-tag "v<prev-version>" --to-tag "v<version>" \
  --branch "<base-branch>" --history-limit 3
```

**Part B: Complete Category List**
- `🆕 Feature`
- `✨ Enhancement`
- `✅ Bugfix`
- `📚 Documentation`

**Purpose**:
- Part A: Analyze the section structure, heading style, emoji usage, and item format from the latest 3 historical release notes
- Part B: Provide a static complete category list so no existing category is omitted
- This static list ensures existing category names are not missed during classification; if the current release has no entries for a category, Step 7 still omits the empty section
- When generating release notes in Step 7, **must** follow both the historical format style and the full category list gathered in Step 3
- If no historical release notes exist, use the default format defined in Step 7

### 4. Collect Merged PRs and Contributors

Use `pullRequests` and `commits` from Step 3. Each commit's `authors` are normalized platform facts containing the git author and co-authors; the skill does not interpret raw platform fields or email rules.

### 5. Collect Related Issues

Use each PR's `closingIssues` from Step 3. Do not parse platform-specific reference syntax in this generic skill.

### 6. Classify Changes

**By type** (from PR title conventional commit prefix):
- `feat`, `perf`, `refactor`, dependency upgrades -> Enhancement
- `fix` -> Bugfix
- `docs` -> Documentation (merge into Enhancement if fewer than 3 items)

**By module** (from PR title scope, labels, or file paths):
- Infer module from PR title brackets like `[module]` or conventional scope `feat(module):`
- Fallback: analyze changed files

### 7. Generate Release Notes

**Prioritize the historical format style obtained in Step 3 and ensure all categories listed in Step 3 are covered.** If historical release notes exist, strictly follow their section structure, heading style (including emojis), item format, and bilingual layout.

If no historical release notes exist, use the following default Markdown format:

```markdown
## {Module/Platform Name}

### Enhancement

- [{scope}] Description by @author in [#N](url)

### Bugfix

- [{scope}] Description by @author in [#N](url)

## Contributors

@contributor1, @contributor2, @contributor3, @reporter1 (reported #N)
```

**Format rules**:
1. Item format: `- [scope] Description by @author in [#N](url)`
2. Issue + PR: `in [#Issue](url) and [#PR](url)`
3. Description: Use PR title, remove `type(scope):` prefix, capitalize first letter
4. **Contributor collection**:
   - **Data sources**:
     - PR authors from the typed context
     - Commit co-authors from the typed context's commit `authors`
     - Issue reporters from typed `closingIssues[].author`
   - **Contribution count**: `PR count + co-authored commit count` for the same identity, merged across both sources
   - **Name -> `@login` mapping**:
     - For `platform-user` or `platform-noreply`, use the lowercased `login`
     - Only for `unresolved`, use the Name heuristic: take the first token before a space and lowercase it
     - If the login already appears in the PR author list, merge counts into that login so `Claude` and `@claude` do not become separate entries
     - Merge all Name variants that map to the same login before counting and sorting; for example, `Claude` and `Claude Opus 4.6 (1M context)` should both collapse into `@claude`
     - Preserve bot identities as-is, for example `dependabot[bot]`
     - If the login still cannot be determined reliably, output `@{lowercased first Name token}` and append `<!-- TODO(reviewer): confirm platform login for {original Name <email>} -->` below the `Contributors` section
   - **Sorting**: descending by contribution count, then lexicographically by login for ties
   - **Deduplication**: use the final mapped `@login` as the key
   - **Issue reporter rules**:
     - Extract `author.login` from each linked Issue collected in Step 5
     - If the login already exists in the final mapped PR author or co-author list, skip it (code contribution already covers this user)
     - Reporter-only contributors use the format `@login (reported #N)`; if the same reporter reported multiple Issues, use `@login (reported #N1, #N2)`
     - Reporters are appended after code contributors in the Contributors section, separated by commas
     - Sort reporters by reported Issue count descending, then lexicographically by login for ties
5. Empty sections: Omit sections with no entries

### 8. Stage, Present, and Confirm

Write the candidate notes to a temporary file outside the working tree, then call typed stage to normalize the file and retain its structured `sha256`:

```bash
NOTES_FILE="$(mktemp "${TMPDIR:-/tmp}/agent-infra-release-notes.XXXXXX")"
agent-infra-internal platform-release-notes stage \
  --notes-file "$NOTES_FILE"
```

Present the exact staged file and delete it before asking. Adjustments invalidate the digest. Only an unambiguous affirmative reply for this preview in the current session authorizes publishing; denial, questions, ambiguity, or interruption stop without publish.

### 9. Recheck and Publish Release Notes

After confirmation, write the confirmed normalized text to a new external temporary file and stage it again. Delete and return to preview if its digest differs. On a match, call:

```bash
agent-infra-internal platform-release-notes publish \
  --tag "v<version>" \
  --title "v<version>" \
  --notes-file "$NOTES_FILE" \
  --expected-sha256 "{preview-sha256}"
```

Delete the temporary file on every exit path. After success, render:

```bash
agent-infra-internal agent-client next-steps \
  --skill post-release \
  --version <version>
```

Output:
```
Release notes updated.

- URL: {release-url}
- Version: v{version}
- Status: Published

The notes have been written to the Release. Edit further at the URL above if needed.
```

## Notes

1. **Requires the platform CLI**: Must have the platform CLI installed and authenticated
2. **Tags must exist**: Run the release skill first to create tags
3. **Release auto-published**: the `v{version}` Release is created and published by the release workflow (the upload target for Homebrew bottles); this skill writes/refreshes the notes on that Release
4. **Classification accuracy**: Auto-classification is based on title/scope/files; complex PRs may need manual adjustment
5. **No leftover artifacts**: Delete preview files before asking and publish files on every exit path; interruption invalidates session-only notes and authorization

## Error Handling

- Invalid version format: Prompt correct format
- Tag not found: Suggest running the release skill first
- The platform CLI is not authenticated: Prompt to authenticate
- No merged PRs found: Prompt to check tags and branch
