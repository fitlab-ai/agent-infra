# Release Commands

This code platform does not provide a release-note adapter.

Local `agent-infra-internal platform-release-notes stage --notes-file "{notes-file}"` still normalizes an external file and returns its digest. Use `context` to receive a structured `PLATFORM_RELEASE_NOTES_UNSUPPORTED` no-op and do not probe another platform client. Publish with `--expected-sha256` remains a no-op until an adapter is provided.
