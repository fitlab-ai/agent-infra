# General Rule - agent-infra Version Stamp

## When to Write

Every time a workflow creates or updates `task.md` frontmatter, also write `agent_infra_version`.

This field records the `agent-infra` CLI version that last wrote the task metadata, and is refreshed together with `updated_at`.

## Value Command

```bash
agent_infra_version=$(ai version --raw 2>/dev/null || echo "unknown")
```

- On success, write the command output directly, for example `vX.Y.Z` or `vX.Y.Z-alpha.0`
- Do not add the `v` prefix in the writer
- If the command fails, write `unknown`

## Frontmatter Field

```yaml
agent_infra_version: {agent_infra_version}
```

## Compatibility

- Historical tasks may not have this field; reading or restoring tasks must not block on that alone
- When present, the value must be `vX.Y.Z`, `vX.Y.Z-prerelease`, a version with SemVer build metadata, or `unknown`
- Issue / PR comment sync does not need special handling; frontmatter mirroring naturally includes this field
