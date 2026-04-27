# Issue Template Matching

Read this file before deciding how to build the Issue body.

## Detect Issue Templates

Issue template detection is platform-specific. Read `.agents/rules/issue-pr-commands.md` and follow the template detection section provided by the configured platform.

If templates exist, inspect their top-level names and choose the best match for the task title and description. Use the candidate template guidance provided by the configured platform rule when available.

If no template matches clearly, choose the nearest candidate. If templates are missing, unreadable, or parsing fails, fall back to the default body path.

## Build the Body from the Matched Template

Build the body by following the field handling and field mapping guidance provided by the configured platform section in `.agents/rules/issue-pr-commands.md`.

When platform guidance is unavailable, use the default body path.
