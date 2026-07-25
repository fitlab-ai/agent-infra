# Release Platform Commands

Release-note platform operations use a typed internal intent. Callers consume structured JSON and do not interpret platform commands, raw fields, identity email rules, or authentication errors.

## Collect Release-note Context

```bash
agent-infra-internal platform-release-notes context \
  --from-tag "v{prev-version}" --to-tag "v{version}" \
  --branch "{branch}" --history-limit 3
```

The result contains release history, pull requests, closing Issues, and normalized contributor identities. Unsupported platforms return a stable `PLATFORM_RELEASE_NOTES_UNSUPPORTED` no-op.

## Publish Release Notes

```bash
agent-infra-internal platform-release-notes publish \
  --tag "v{version}" --title "v{version}" --notes-file "{notes-file}"
```

The command updates an existing Release or creates a missing one. `--dry-run` only plans the operation. Exit codes `0/1/2` mean success, failure, and blocked.
