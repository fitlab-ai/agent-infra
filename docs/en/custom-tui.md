# Custom TUI Next-Step Commands

[← Back to README](../../README.md) · [中文](../zh-CN/custom-tui.md)

Register a custom CLI/TUI as a sandbox tool in `.agents/.airc.json`. Add its ID to `sandbox.tools.ids` and define an `invoke` template. The selected tool then appears in lifecycle next-step guidance even when no built-in Agent Client is enabled.

```json
{
  "sandbox": {
    "tools": {
      "ids": ["agent-infra", "your-tui"],
      "definitions": {
        "your-tui": {
          "name": "Your TUI",
          "invoke": "your-cli ${skillName}"
        }
      }
    }
  }
}
```

`invoke` supports `${skillName}` and `${projectName}`. For a namespaced command, use a template such as `/${projectName}:${skillName}`. The name is optional and defaults to the tool ID.

Custom skills use the shared `.agents/skills/` location. Maintain any client-specific command files in that client's own configuration; `update-agent-infra` does not inspect or generate those files.
