---
name: create-release-note
description: "Generate release notes from PRs and commits"
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

Fetch multiple published release notes as format references, then use a predefined complete category list:

Read `.agents/rules/release-commands.md` before this step.

```bash
# Part A: fetch the latest 3 published release bodies by following the release query commands in `.agents/rules/release-commands.md`
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

Get the date range between tags, then query merged PRs:

```bash
# Get tag dates
git log v<prev-version> --format=%aI -1
git log v<version> --format=%aI -1

# Get merged PRs in range by following the merged-PR query command in `.agents/rules/release-commands.md`
```

Also collect direct commits without PRs:
```bash
git log v<prev-version>..v<version> --format="%H %s" --no-merges
```

Collect collaborative contributors from commit `Co-authored-by` trailers:

```bash
git log v<prev-version>..v<version> \
  --no-merges \
  --format='%(trailers:key=Co-authored-by,valueonly,unfold)' \
  | grep -v '^$' | sort | uniq -c | sort -rn
```

Each output line is `Name <email>` and `uniq -c` provides the number of commits where that identity appeared as a co-author within the range.

### 5. Collect Related Issues

From each PR body, extract linked Issues:
- Match patterns: `Closes #N`, `Fixes #N`, `Resolves #N` (case-insensitive)

Read linked Issues by following `.agents/rules/release-commands.md`.

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
     - PR authors from Step 4 `gh pr list --json author`
     - Commit co-authors from Step 4 `git log ... --format='%(trailers:key=Co-authored-by,valueonly,unfold)'`
     - Issue reporters from linked Issues collected in Step 5 (`author.login` returned by `gh issue view`)
   - **Contribution count**: `PR count + co-authored commit count` for the same identity, merged across both sources
   - **Name -> `@login` mapping**:
     - Raw `Co-authored-by` values are `Name <email>` and must be mapped to a GitHub `@login`
     - Prefer email extraction: if it matches `(\d+\+)?(\S+?)@users\.noreply\.github\.com`, use the second capture group lowercased; this regex covers both `{id}+{login}@users.noreply.github.com` and `{login}@users.noreply.github.com`
     - Otherwise use a Name heuristic: take the first token before a space and lowercase it, for example `Claude Opus 4.6 (1M context)` -> `@claude`, `Codex` -> `@codex`, `Gemini` -> `@gemini`
     - If the login already appears in the PR author list, merge counts into that login so `Claude` and `@claude` do not become separate entries
     - Merge all Name variants that map to the same login before counting and sorting; for example, `Claude` and `Claude Opus 4.6 (1M context)` should both collapse into `@claude`
     - Preserve bot identities as-is, for example `dependabot[bot]`
     - If the login still cannot be determined reliably, output `@{lowercased first Name token}` and append `<!-- TODO(reviewer): confirm GitHub login for {original Name <email>} -->` below the `Contributors` section
   - **Sorting**: descending by contribution count, then lexicographically by login for ties
   - **Deduplication**: use the final mapped `@login` as the key
   - **Issue reporter rules**:
     - Extract `author.login` from each linked Issue collected in Step 5
     - If the login already exists in the final mapped PR author or co-author list, skip it (code contribution already covers this user)
     - Reporter-only contributors use the format `@login (reported #N)`; if the same reporter reported multiple Issues, use `@login (reported #N1, #N2)`
     - Reporters are appended after code contributors in the Contributors section, separated by commas
     - Sort reporters by reported Issue count descending, then lexicographically by login for ties
5. Empty sections: Omit sections with no entries

### 8. Present and Confirm

Show the generated release notes to the user.

Ask:
1. Need any adjustments?
2. Create a GitHub Draft Release?

### 9. Create Draft Release (If Confirmed)

Create the draft release by following `.agents/rules/release-commands.md`.

Output:
```
Draft Release created.

- URL: {draft-release-url}
- Version: v{version}
- Status: Draft

Please review and publish on GitHub:
1. Open the URL above
2. Review the release notes
3. Click "Publish release"
```

## Notes

1. **Requires gh CLI**: Must have GitHub CLI installed and authenticated
2. **Tags must exist**: Run the release skill first to create tags
3. **Draft mode**: Creates a draft - won't auto-publish
4. **Classification accuracy**: Auto-classification is based on title/scope/files; complex PRs may need manual adjustment

## Error Handling

- Invalid version format: Prompt correct format
- Tag not found: Suggest running the release skill first
- gh not authenticated: Prompt to authenticate
- No merged PRs found: Prompt to check tags and branch
