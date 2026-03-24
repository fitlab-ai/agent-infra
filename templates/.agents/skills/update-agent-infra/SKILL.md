---
name: update-agent-infra
description: "Update the project AI collaboration configuration"
---

# Update Project

## Execution constraints

1. **Script-driven deterministic steps**: managed / ejected file processing,
   registry sync, and config updates are ALL handled by `sync-templates.js`.
   Never process these files manually one by one.
   The script guarantees atomicity and idempotency.

2. **No subagent delegation**: Phase B (merged file intelligent merging) MUST
   be executed directly in the main conversation. Never delegate to subagents.
   Subagents have limited context and frequently misjudge file content equality.

## Phase A: Run sync script (deterministic)

Execute the following command to handle all deterministic steps at once:

```bash
node .agents/skills/update-agent-infra/scripts/sync-templates.js
```

The script reads `.agents/.airc.json` (including `templateSource`, default `templates/`) and automatically performs:
- detect the template source version
- File registry sync (`defaults.json` → `.agents/.airc.json`)
- All managed files (language selection → exclude merged/ejected → placeholder rendering → overwrite)
- Ejected files (create only on first install)
- `.agents/.airc.json` update (`templateVersion`, file lists)

The script outputs JSON to stdout. Parse and record the report.

**Key fields**:
- `error`: error message (if non-empty, stop and report)
- `templateVersion`: current template source version
- `templateRoot`: absolute path to the template file root directory
- `managed.written` / `managed.created`: updated / newly created managed files
- `merged.pending`: list of merged files for AI to process
  - Each item has `target` (project-relative path) and `template` (template-root-relative path)
- `registryAdded`: newly added file registry entries
- `selfUpdate`: whether this is a self-update scenario
- `configUpdated`: whether `.agents/.airc.json` was updated

## Phase B: Process merged files (AI intelligent merge)

Process each item in the report's `merged.pending` list:

1. Read the template file from `<templateRoot>/<template>`
2. Render placeholders: replace double-brace `project` and `org` placeholders with actual values from .agents/.airc.json
3. Read the current local file (`<project-root>/<target>`)

**If the local file does not exist** (first-time setup), write the rendered
template directly and skip merge.

If the local file exists, execute the following merge algorithm:

### B.1 Use template as the base

Use the rendered new template as the output base. The template represents
best practices; its structure and content are authoritative.

### B.2 Extract deltas from local file

Scan the local file for content that goes beyond the template (user deltas):
- **Filled TODOs**: Template TODO placeholders replaced with actual content
- **Added sections**: Content in local file that does not exist in template
- **Extended content**: Supplementary details added to existing template sections

### B.3 Merge deltas into template

Insert extracted deltas into appropriate positions in the new template:
- Filled TODOs → replace the corresponding TODO placeholder
- Added sections → insert at the most relevant location
- Extended content → merge into the corresponding section

### B.4 Full read-through

Review the merged file for logical completeness. Verify:
- Deltas are placed correctly
- No duplicate content
- Document structure is coherent

### B.5 Conflict handling

When user-modified content conflicts with new template content:
- Keep the template version (template authority principle)
- Flag the conflict in the report so the user can confirm

### B.6 Remaining TODOs

After merge, if template TODOs remain unfilled by local file content,
flag them in the report for the user.

## Phase C: Verify and output report

**Direction check**: Spot-check with `git diff` that the change direction
is correct (correct: new template content → local; wrong: reverting rendered
content back to placeholders). If wrong-direction changes are found,
pause and investigate.

### Self-update detection

Check whether `git diff` includes changes to
`.agents/skills/update-agent-infra/SKILL.md`.
If this file was modified during the current update, append the following
warning to the end of the report:

```
⚠ The update-agent-infra skill itself was updated.
  Please run /update-agent-infra again to ensure all new logic takes effect.
```

> **Rationale**: The current execution used the old skill logic; the new version
> may contain additional processing steps. Running again ensures the new logic
> is fully applied.
> Alternatively, users can run `ai update` before executing the skill to
> pre-update the seed files and avoid the need for a second run.

### Output report

Based on the script report and merged results, output a complete update report including:
- Template version change
- File registry additions
- Managed file change details (updated, created, skipped merged files)
- Merged file results (conflicts, remaining TODOs)
- Ejected file processing
- Self-update detection result

Output the report, then **STOP** — do not make other changes to the project.
