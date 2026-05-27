# Release Platform Commands

Read this file before loading release history, querying merged PRs, or publishing the Release notes.

## Query Releases

```bash
gh release list --limit {limit} --json tagName,isDraft,isPrerelease
gh release view "{tag}" --json body,url
```

## Query Merged PRs

```bash
gh pr list --state merged --base "{branch}" --json number,title,mergedAt,labels
```

When needed, read the linked Issue:

```bash
gh issue view {issue-number} --json number,title,labels,url
```

## Contributor Mapping Helpers

Merged PR queries used for release notes should include authors when contributors are needed:

```bash
gh pr list --state merged --base "{branch}" --json number,title,mergedAt,labels,author
```

Linked Issue queries used for reporter attribution should include the author:

```bash
gh issue view {issue-number} --json number,title,labels,url,author
```

Map GitHub no-reply emails with this rule: if `Name <email>` contains an email matching `(\d+\+)?(\S+?)@users\.noreply\.github\.com`, use the second capture group lowercased as the login. This covers both `{id}+{login}@users.noreply.github.com` and `{login}@users.noreply.github.com`.

## Publish the Release Notes

The GitHub Release for `v{version}` is created and published automatically by the release workflow so Homebrew bottles have a stable upload target. This command writes the curated notes onto that existing Release, falling back to creating it if it does not exist yet.

```bash
if gh release view "v{version}" >/dev/null 2>&1; then
  gh release edit "v{version}" --notes-file "{notes-file}"
else
  gh release create "v{version}" --title "v{version}" --notes-file "{notes-file}"
fi
```

If commands fail, stop or escalate according to the calling skill.
