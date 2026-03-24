# Issue Template Matching

Read this file before deciding how to build the Issue body from `.github/ISSUE_TEMPLATE`.

#### 3a. Detect Issue Templates

Search project templates with:

```bash
rg --files .github/ISSUE_TEMPLATE -g '*.yml' -g '!config.yml'
```

If templates exist, inspect their top-level `name:` fields and choose the best match for the task title and description.

Typical candidate templates:
- `bug_report.yml` for bug work
- `question.yml` for question or investigation work
- `feature_request.yml` for feature work
- `documentation.yml` for documentation work
- `other.yml` as the general fallback

If no template matches clearly, choose the nearest candidate. If templates are missing, unreadable, or parsing fails, fall back to the default body path.

#### 3b. Build the Body from the Matched Template

Read the matched template's:
- `name`
- `type:`
- `labels:`
- `body:`

Field handling rules:
- `textarea` and `input`: use `attributes.label` as the markdown heading and fill values from task.md
- `markdown`: skip template explanation prose
- `dropdown` and `checkboxes`: skip
- when task.md lacks a suitable value, write `N/A`

Suggested field mapping:

| Template field hint | task.md source |
|---|---|
| `summary`, `title` | task title |
| `description`, `problem`, `what happened`, `issue-description`, `current-content` | task description |
| `solution`, `requirements`, `steps`, `suggested-content`, `impact`, `context`, `alternatives`, `expected` | requirements list |
| other `textarea` / `input` fields | task description, otherwise `N/A` |
