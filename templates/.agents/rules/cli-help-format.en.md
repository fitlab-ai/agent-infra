# CLI help text conventions

Unify the help text display structure, display name, and command ordering of the `ai` / `agent-infra` CLI so newly added subcommands follow them automatically and never drift across levels again. Read this file before adding or changing CLI help text.

## Scope

- **Display name `ai`**: applies to **all** user-facing help / usage / banner text — top-level, namespace-level, and the single-line usage / startup banners of leaf commands such as `merge` / `init` / `update`. The only exceptions: the top-level help first line keeps the brand + version line `agent-infra ${VERSION}`, and `@fitlab-ai/agent-infra` in package names / install commands / repo URLs stays as-is.
- **Structure & ordering** (`Usage:` + `Commands:` structure, alphabetical command order): applies only to levels that carry a `Commands:` listing — top-level help (`bin/cli.ts`) and namespace-level help (e.g. `ai sandbox` / `ai task`). Leaf commands have only a single-line usage and need no `Commands:` structure.

## Display name

- Use **`ai`** as the command display name in help text (the recommended short form; `package.json`'s `bin` registers both `ai` and `agent-infra`).
- Keep the top-level help first line as the brand + version line `agent-infra ${VERSION} - bootstrap ...` (it is the brand and version marker that several tests anchor on).
- Keep `@fitlab-ai/agent-infra` in install methods, package names, and repo URLs as-is (those are package names, not command display names).

## List structure

Namespace-level and top-level help follow:

```
Usage: ai <ns> <command> [options]

Commands:
  <command>  <description aligned from two spaces>
  ...

Run 'ai <ns> <command> --help' for details.
```

- The `Commands:` block uses bare command names (no repeated binary name), two-space indent, descriptions aligned to the longest command name.
- Namespace-level help ends with a `Run 'ai <ns> <command> --help' for details.` footer.
- Top-level help has no uniform subcommand `--help` convention, so the footer is not required there; if an `Examples:` section exists, its command display name is also `ai`.

## Ordering

Command lists, `Examples`, and command enumerations embedded in descriptions are all sorted by the **first token of the command, in ascending alphabetical order**:

- Multi-token commands (e.g. `vm status|start|stop`) sort by the first token (`vm`).
- Commands with angle/square-bracket parameters sort by the command name (the bare word before the parameters).
- Case-insensitive.

## Checklist for adding a subcommand

When adding a subcommand:

1. Insert the command at the correct alphabetical position in `Commands:`.
2. If it has examples, insert them at the alphabetical position in `Examples:`.
3. If a top-level `task` / `sandbox` description has an embedded command enumeration, update its alphabetical order too.
4. Sync the corresponding help test's **structural** assertions (whether the command appears, whether the `Usage:` / `Commands:` header exists); do not bind to full sentences (see [`testing-discipline.md`](testing-discipline.md)).
