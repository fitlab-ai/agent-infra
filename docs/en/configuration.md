# Configuration Reference

[← Back to README](../../README.md) · [中文](../zh-CN/configuration.md)

The generated `.agents/.airc.json` file is the central contract between the bootstrap CLI, templates, and future updates.

## Example `.agents/.airc.json`

```json
{
  "project": "my-project",
  "org": "my-org",
  "language": "en",
  "templateVersion": "v0.6.5",
  "agentClients": [
    {
      "id": "claude-code",
      "enabled": true,
      "installInSandbox": true,
      "orchestration": {
        "executor": { "model": "<model-id>", "reasoningEffort": "<host-value>" },
        "reviewer": { "model": "<model-id>", "reasoningEffort": "<host-value>" }
      }
    },
    { "id": "codex", "enabled": true, "installInSandbox": true },
    { "id": "antigravity-cli", "enabled": true, "installInSandbox": true },
    { "id": "opencode", "enabled": true, "installInSandbox": true }
  ],
  "templates": {
    "sources": [
      { "type": "local", "path": "~/private-templates" }
    ]
  },
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" }
    ]
  },
  "customTUIs": [
    {
      "name": "<your-tui-name>",
      "dir": ".<your-tui>/commands",
      "invoke": "<your-cli> ${skillName}"
    }
  ],
  "files": {
    "managed": [
      ".agents/workspace/README.md",
      ".agents/skills/",
      ".agents/templates/",
      ".agents/workflows/",
      ".claude/commands/",
      ".opencode/commands/"
    ],
    "merged": [
      ".agents/README.md",
      ".gitignore",
      "AGENTS.md"
    ],
    "ejected": []
  }
}
```

## Field reference

| Field | Meaning |
|-------|---------|
| `project` | Project name used when rendering commands, paths, and templates. |
| `org` | GitHub organization or owner used by generated metadata and links. |
| `language` | Primary project language or locale used by rendered templates. |
| `templateVersion` | Exact `v`-prefixed SemVer of the installed template package, including prerelease or build metadata, for future upgrades and drift tracking. |
| `agentClients` | Canonical configuration for the four built-in AI Coding Agent Clients. |
| `templates` | Optional external template overlay configuration. |
| `templates.sources` | Optional ordered list of external template sources. Only `type: "local"` is supported today. |
| `skills` | Optional custom skill sync configuration. |
| `skills.sources` | Optional ordered list of external custom skill sources. Only `type: "local"` is supported today. |
| `customTUIs` | Optional top-level list of custom AI TUI adapters. |
| `files` | Per-path update strategy configuration for managed, merged, and ejected files. |
| `files.managedBaselines` | Tool-maintained SHA-256 source baselines for built-in guarded managed files. Do not edit manually; they enable safe three-way updates for the GitHub lifecycle workflows. |

## Agent Client contract

An **AI Coding Agent Client**, or **Agent Client** for short, is a supported coding-agent application such as Claude Code, Codex, Antigravity CLI, or OpenCode. The canonical `agentClients` array contains each built-in client exactly once. Array order has no runtime meaning; agent-infra serializes entries in the stable order shown above.

| Field | Meaning |
|-------|---------|
| `id` | Closed built-in client identifier: `claude-code`, `codex`, `antigravity-cli`, or `opencode`. |
| `enabled` | Whether the project enables client-specific files and integration. |
| `installInSandbox` | Whether sandbox assembly should install this client. This is independent of `enabled`. |
| `orchestration` | Optional complete default policy for this client. If present, both roles require non-empty `model` and host-native `reasoningEffort`; the role models may be equal. |

`run-task` treats explicit policy as atomic: supplying any role model/effort flag requires all four role fields and never fills omissions from configuration. With no explicit policy, it reads only the selected client's `orchestration`. The selected policy is persisted in schema v2 together with its source; changing configuration does not hot-switch an active run. Model discovery is reported separately as a `complete` or `partial` catalog, or `interactive-only` guidance. A tool's local override enum is not a complete catalog.

A configured model policy does not imply lifecycle support. `run-task` only delegates when the selected client can report verified actual model and reasoning-effort evidence. Claude Code currently cannot report both values from its native start event, so its built-in adapter keeps orchestration unsupported and `prepare` fails closed before creating a delegation.

Three configuration concepts remain independent:

- `agentClients` records the project's desired state for built-in clients.
- `sandbox.tools` contains non-Agent Client sandbox tools, including `agent-infra` and custom tools.
- Adapter capabilities describe what a client integration can do. They do not change when a project disables that client.

Each adapter capability uses one of these identifiers:

| Capability | Boundary |
|------------|----------|
| `instructions` | Discovers or consumes persistent repository and directory instructions. |
| `skills` | Discovers, loads, or invokes `SKILL.md` workflow packages. |
| `commands` | Provides client-native command entry points, files, and invocation syntax. |
| `hooks` | Integrates lifecycle, tool-call, or event callbacks. |
| `sandbox` | Supports CLI installation, version detection, configuration or credential mounting, initialization, and status. |
| `verification` | Participates in project checks, required checks, or task artifact verification. |

Support maturity is recorded per capability as a single closed level:

| Level | Meaning |
|-------|---------|
| `compatible` | The client can consume the generic contract without client-specific assembly. |
| `integrated` | Client-specific integration exists. |
| `verified` | The integration has reproducible evidence for the current supported version. |
| `experimental` | The capability is usable, but its contract or behavior may change. |

The `verification` capability names an integration area; the `verified` support level names maturity. They are not interchangeable.

### Legacy migration

The old built-in `tuis` field and built-in Agent Client IDs in `sandbox.tools` are migration inputs only:

- If `agentClients` is absent, a valid `tuis` array maps membership to `enabled`. A missing, `null`, or non-array value enables all four clients; an empty array disables all four.
- A non-empty `sandbox.tools` array maps built-in client membership to `installInSandbox`. Missing, non-array, and empty arrays preserve the previous runtime behavior by installing all four clients.
- Built-in client IDs are removed from the migrated `sandbox.tools`. `agent-infra`, custom tools, and other non-client string IDs retain their original order.
- `customTUIs` remains an independent extension mechanism and is not migrated into `agentClients`.
- When canonical and legacy fields coexist, their projected client states must agree. A conflict fails validation instead of silently choosing one source.

Normalization and migration are currently exposed as a pure configuration contract. Existing init, update, and sandbox workflows adopt it in a later integration phase.

## External template and skill sources

Use external sources when your team maintains private platform templates, private rules, or shared custom skills outside this repository. You can configure them during `agent-infra init` or later by editing `.agents/.airc.json`:

```json
{
  "templates": {
    "sources": [
      { "type": "local", "path": "~/private-templates" },
      { "type": "local", "path": "~/team-overrides/templates" }
    ]
  },
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" }
    ]
  }
}
```

Template source precedence is built-in templates first, then external sources as supplements. External files with the same path as built-in templates are ignored and reported in `templateSources.conflicts`; between external sources, later entries override earlier entries and conflicts are also reported. Skill sources use the same local-source shape, but custom skills cannot replace built-in skills.

External template files and skill scripts can include executable JavaScript or shell commands that AI workflows may run. Only use trusted local paths.

## Version Management

agent-infra uses semantic versioning through Git tags and GitHub releases. The installed template package's exact `v`-prefixed SemVer is recorded in `.agents/.airc.json` as `templateVersion`, including any prerelease or build metadata. This gives both humans and AI tools a stable reference point for upgrades.
