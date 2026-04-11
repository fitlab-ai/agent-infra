# Release Platform Commands

Read this file before loading release history, querying merged PRs, or creating a draft release.

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

## Create a Draft Release

```bash
gh release create "v{version}" --draft --title "v{version}" --notes-file "{notes-file}"
```

If commands fail, stop or escalate according to the calling skill.
