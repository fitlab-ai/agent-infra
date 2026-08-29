# Release Platform Commands

Release-note platform operations use a typed internal intent. Callers consume structured JSON and do not interpret platform commands, raw fields, identity email rules, or authentication errors.

## Collect Release-note Context

```bash
agent-infra-internal platform-release-notes context \
  --from-tag "v{prev-version}" \
  --to-tag "v{version}" \
  --branch "{branch}" \
  --history-limit 3
```

The result contains `history`, `pullRequests`, `closingIssues`, and commit `authors` with normalized `login` / `resolution` values. `status: no-op` with error code `PLATFORM_RELEASE_NOTES_UNSUPPORTED` means the current platform does not support remote release-note operations.

### Identity Safety Boundary

- Render an identity as `@login` only when `resolution` is `platform-user` or `platform-noreply` and `login` is non-empty.
- Exclude `resolution: unresolved` identities from the release-note contributor list. Never infer a login from a name, email address, domain, brand, or same-named platform account, and never substitute a guessed personal or organization account.
- Do not publish unresolved identity emails or identity-verification TODOs in Release notes. Record any required investigation outside the release workflow without creating a platform mention.

## Stage Release Notes

```bash
agent-infra-internal platform-release-notes stage \
  --notes-file "{notes-file}"
```

The command accepts only an external regular file, normalizes it atomically, and returns SHA-256 for its exact bytes.

## Publish Release Notes

Call this only after user confirmation:

```bash
agent-infra-internal platform-release-notes publish \
  --tag "v{version}" \
  --title "v{version}" \
  --notes-file "{notes-file}" \
  --expected-sha256 "{preview-sha256}"
```

The command recomputes the digest before platform access and performs no platform write on mismatch. On a match it updates an existing Release or creates it when missing; `--dry-run` returns only the planned operation. Exit code `0` means success, `1` means a stable failure, and `2` means a network or platform block.
