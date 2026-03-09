---
name: "create-release-note"
description: "Auto-generate structured Release Notes from PR/commit and optionally create GitHub Draft Release"
usage: "/create-release-note <version> [prev-version]"
---

# Create Release Note Command

## Description

Automatically collect change information from PRs, commits, and Issues, classify by module and type, and generate Release Notes conforming to the project format. Supports creating a GitHub Draft Release.

For x.y.0 versions, supports merging previously published release notes from the prior minor series without recalculating.

## Usage

```bash
/release-notes <version>                # Auto-detect previous version
/release-notes <version> <prev-version> # Manually specify version range
```

For example:
```bash
/create-release-note 3.6.3           # Auto-detect previous version as 3.6.2
/create-release-note 3.6.3 3.6.2     # Manually specify range
/create-release-note 3.7.0           # x.y.0 version: merge all release notes from 3.6.x series
```

## Parameters

- `<version>`: Current release version, format `X.Y.Z` (required)
- `<prev-version>`: Previous version, format `X.Y.Z` (optional, auto-detected if not provided)

Argument source: `$ARGUMENTS`

## Execution Steps

Steps 1-3 are common steps. Step 3 branches based on version type:
- **Merge path** (PATCH == 0, e.g., `3.7.0`): Steps 4-7 → skip to Step 14
- **Regular path** (PATCH > 0, e.g., `3.6.3`): Steps 8-13 → continue to Step 14

Steps 14-15 are common steps.

### Step 1: Parse Arguments

Extract arguments from `$ARGUMENTS`. Two forms are supported:
- Single argument: `<version>` — current version
- Double arguments: `<version> <prev-version>` — current and previous version

**Version format validation**:
- Must match `X.Y.Z` format (X, Y, Z are non-negative integers)
- If format is invalid, error: "Version format incorrect, expected X.Y.Z (e.g., 3.6.3)"

### Step 2: Determine Version Range

**Current version tag**: `v<version>` (e.g., `v3.6.3`)

**Previous version tag detection logic** (only when `<prev-version>` is not specified):

```bash
# Get all sorted tags
git tag --sort=-v:refname
```

- If PATCH > 0 (e.g., `3.6.3`): Find the previous tag in the same minor series (e.g., `v3.6.2`)
- If PATCH == 0 (e.g., `3.6.0`): Find the last tag of the previous minor series (e.g., the highest in `v3.5.x`)

**Verify tags exist**:

```bash
git rev-parse v<version>
git rev-parse v<prev-version>
```

If either tag doesn't exist, error: "Tag v<version> does not exist, please confirm the tag has been created"

### Step 3: Determine Version Type and Choose Path

Choose a different generation path based on the PATCH component:

- **If PATCH == 0** (e.g., `3.7.0`) → take the **Merge path**, starting from Step 4
- **If PATCH > 0** (e.g., `3.6.3`) → take the **Regular path**, starting from Step 8

---

### Merge Path (PATCH == 0, x.y.0 versions)

### Step 4: Find All Published Releases from Previous Minor Series

```bash
gh release list --limit 50 --json tagName,isDraft,isPrerelease
```

Filter entries matching:
- `tagName` starts with `vX.(Y-1).` (e.g., for version `3.7.0`, filter `v3.6.` prefix)
- `isDraft == false`
- `isPrerelease == false`

If no published releases are found, prompt user and fall back to Regular path (Step 8).

### Step 5: Get Release Body for Each Version in Ascending Order

For each release tag filtered in Step 4, get its content in version ascending order:

```bash
gh release view v<tag> --json body --jq .body
```

### Step 6: Merge All Release Bodies

Merge the release notes from each version into one comprehensive document:

1. **Concatenate in version order**: Process in order of `v3.6.1`, `v3.6.2`, `v3.6.3`, ...
2. **Merge same-platform same-type entries**: Combine entries of the same platform and type (e.g., same Enhancement section)
3. **Deduplicate Contributors**: Merge all Contributors sections, deduplicate, sort by contribution count (appearances) descending

### Step 7: Generate Overview

x.y.0 versions are always treated as Major releases:

1. **Add `🌟 Overview` summary at the top**: AI generates 2-3 sentences summarizing the core themes and highlights of the entire minor series
2. **Add `🚀 Features Overview` bullet list per platform**: Extract 3-5 key feature highlights from each platform's Enhancement entries

**After completion, skip to Step 14.**

---

### Regular Path (PATCH > 0)

### Step 8: Collect Merged PRs

**Primary data source** — Get the date range between two tags, then query merged PRs with `gh` CLI:

```bash
# Get dates for both tags
git log v<prev-version> --format=%aI -1
git log v<version> --format=%aI -1

# Get target branch (inferred from version number, e.g., 3.6.x)
# Branch name format: X.Y.x

# Get PRs merged to target branch
gh pr list --state merged --base <branch> \
  --json number,title,body,author,labels,mergedAt,url \
  --limit 200 --search "merged:YYYY-MM-DD..YYYY-MM-DD"
```

**Supplementary data source** — Get direct commits without associated PRs:

```bash
git log v<prev-version>..v<version> --format="%H %s" --no-merges
```

Compare PR list with commit list to find commits not associated with any PR (these should also be included in release notes).

### Step 9: Collect Related Issues

Extract linked Issues from each PR's body:
- Match patterns: `Closes #N`, `Fixes #N`, `Resolves #N` (case-insensitive)
- Also match: `close #N`, `fix #N`, `resolve #N` and their plural forms

For each extracted Issue number:

```bash
gh issue view <N> --json number,title,labels,url
```

Collect Issue details to enrich release notes descriptions.

### Step 10: Classify — Group by Module

Determine each PR/commit's module using the following **priority**:

| Priority | Criteria | Example |
|----------|----------|---------|
| 1 | Module tag in PR title `[module]` | `[fit] Fix NPE` → FIT |
| 2 | Conventional commit scope `feat(module):` | `feat(core): xxx` → Core |
| 3 | PR changed file paths (using `gh pr view <N> --json files`) | `src/core/**` → Core |
| 4 | Default to main module | |

### Step 11: Classify — Group by Type

Classify based on PR title conventional commit type:

| PR Title Prefix / Feature | Category |
|---------------------------|----------|
| `feat`, `perf`, `refactor`, `chore(deps)`, dependency upgrades | ✨ Enhancement |
| `fix` | ✅ Bugfix |
| `docs` | 📚 Documentation (merge into Enhancement if fewer than 3 items) |

### Step 12: Determine Release Level

Determine output detail level based on change volume and nature:

- **Major release** (merged PRs > 15):
  - Generate `🌟 Overview` summary (2-3 sentences summarizing the core theme)
  - Generate `🚀 Features Overview` bullet list per platform
- **Regular release**:
  - List Enhancement / Bugfix items directly without Overview

### Step 13: Generate Release Notes

Output markdown following the project's existing format. Full template:

```markdown
## {Platform/Module Name}

### ✨ Enhancement

- [{scope}] Description by @author1 and @author2 in [#123](url)
- Upgrade xxx from v1 to v2 by @author in [#456](url)

### ✅ Bugfix

- [{scope}] Fix xxx issue by @author in [#100](issue-url) and [#789](pr-url)

## ❤️ Contributors

@contributor1, @contributor2, @contributor3
```

**Format rules** (extracted from existing release notes):

1. **Item format**: `- [module] Description by @author1 and @author2 in [#N](url)`
2. **Linked Issue and PR**: `in [#Issue](issue-url) and [#PR](pr-url)`
3. **Commits without PR**: Omit `in [#N]` part, write description directly
4. **Description content**: Prefer PR title, remove `type(scope):` prefix, capitalize first letter
5. **Contributors list**: Deduplicate, sort by contribution count (PR count) descending
6. **Empty platforms**: If a platform has no changes, omit that platform's section
7. **Multiple authors**: If PR has multiple co-authors, connect with `and`: `by @a and @b`

---

### Common Steps

### Step 14: Present and Confirm

**Display the complete** generated release notes for user review.

Then ask the user:
1. Whether adjustments are needed (modify descriptions, adjust classification, add/remove items, etc.)
2. Whether to create a GitHub Draft Release

If the user requests adjustments, modify accordingly and re-display.

### Step 15: Create Draft Release

After user confirmation, write release notes to a temp file, then create Draft Release:

```bash
gh release create v<version> \
  --title "v<version>" \
  --notes-file /tmp/release-notes-v<version>.md \
  --target <release-branch-or-tag> \
  --draft
```

Output result:
```
Draft Release created

- Release URL: <draft-release-url>
- Version: v<version>
- Status: Draft

Please review and publish on GitHub:
1. Open the URL above
2. Review the Release Notes content
3. Click "Publish release" when ready
```

## Notes

1. **Requires `gh` CLI**: This command depends on GitHub CLI (`gh`), ensure it's installed and authenticated
2. **Tags must exist**: Before running this command, ensure `v<version>` and the previous version's tag have been created (usually done by the `/release` command)
3. **Draft mode**: Creates a draft Release, won't auto-publish; requires manual review and publishing on GitHub
4. **PR search scope**: Based on date range search, may include a few out-of-range PRs; the command will try to filter them
5. **Module classification accuracy**: Auto-classification is based on title/scope/file paths; complex PRs may need manual adjustment
6. **x.y.0 merge path**: Depends on the previous minor series having published (non-Draft) releases on GitHub; if no published releases exist, falls back to the regular path

## Error Handling

- **Invalid version format**: Prompt correct format and exit
- **Tag not found**: Prompt to confirm tag is created (may need to run `/release` first)
- **`gh` CLI not installed or authenticated**: Prompt installation/authentication methods
- **No merged PRs**: Prompt that no merged PRs were found in the version range, suggest checking tags and branches
- **GitHub API rate limit**: Prompt to retry later
- **x.y.0 no published releases**: Prompt that no published releases exist for the previous minor series, falling back to regular path

## Related Commands

- `/release <version>` - Execute version release workflow (create tag and release branch)
- `/commit` - Commit code
- `/create-pr` - Create Pull Request
