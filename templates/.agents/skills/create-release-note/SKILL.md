---
name: create-release-note
description: >
  Generate release notes from PRs and commits between two versions.
  Triggered when the user requests release note generation.
  Arguments: version number, optional previous version.
---

# Create Release Notes

Generate comprehensive release notes for a version based on merged PRs and commits.

## Execution Flow

### Step 1: Parse Arguments

From arguments:
- `<version>`: Current release version (required), format `X.Y.Z`
- `<prev-version>`: Previous version (optional), auto-detected if not provided

### Step 2: Determine Version Range

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

### Step 3: Collect Merged PRs

Get the date range between tags, then query merged PRs:

```bash
# Get tag dates
git log v<prev-version> --format=%aI -1
git log v<version> --format=%aI -1

# Get merged PRs in range
gh pr list --state merged --base <branch> \
  --json number,title,body,author,labels,mergedAt,url \
  --limit 200 --search "merged:YYYY-MM-DD..YYYY-MM-DD"
```

Also collect direct commits without PRs:
```bash
git log v<prev-version>..v<version> --format="%H %s" --no-merges
```

### Step 4: Collect Related Issues

From each PR body, extract linked Issues:
- Match patterns: `Closes #N`, `Fixes #N`, `Resolves #N` (case-insensitive)

```bash
gh issue view <N> --json number,title,labels,url
```

### Step 5: Classify Changes

**By type** (from PR title conventional commit prefix):
- `feat`, `perf`, `refactor`, dependency upgrades -> Enhancement
- `fix` -> Bugfix
- `docs` -> Documentation (merge into Enhancement if fewer than 3 items)

**By module** (from PR title scope, labels, or file paths):
- Infer module from PR title brackets like `[module]` or conventional scope `feat(module):`
- Fallback: analyze changed files

### Step 6: Generate Release Notes

Format as Markdown:

```markdown
## {Module/Platform Name}

### Enhancement

- [{scope}] Description by @author in [#N](url)

### Bugfix

- [{scope}] Description by @author in [#N](url)

## Contributors

@contributor1, @contributor2, @contributor3
```

**Format rules**:
1. Item format: `- [scope] Description by @author in [#N](url)`
2. Issue + PR: `in [#Issue](url) and [#PR](url)`
3. Description: Use PR title, remove `type(scope):` prefix, capitalize first letter
4. Contributors: Deduplicated, sorted by contribution count (descending)
5. Empty sections: Omit sections with no entries

### Step 7: Present and Confirm

Show the generated release notes to the user.

Ask:
1. Need any adjustments?
2. Create a GitHub Draft Release?

### Step 8: Create Draft Release (If Confirmed)

```bash
gh release create v<version> \
  --title "v<version>" \
  --notes-file /tmp/release-notes-v<version>.md \
  --draft
```

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
