---
name: update-ai-collaboration
description: >
  Update the current project's AI collaboration infrastructure
  and project governance to match the latest ai-collaboration-installer
  templates. Intelligently merges template changes while
  preserving project-specific customizations.
---

# Update Project

## Step 1: Read project config

Read `collaborator.json` from project root.
Extract: source, project, org, language,
modules, templateSource, files (managed/merged/ejected lists).

## Step 2: Locate and refresh template source

1. If `~/.ai-collaboration-installer/` does not exist, report error and stop:
   "Template source not found. Please install first:
   curl -fsSL https://raw.githubusercontent.com/fitlab-ai/ai-collaboration-installer/main/install.sh | sh"
2. Run `git -C ~/.ai-collaboration-installer pull` to fetch the latest templates.
3. Read from `~/.ai-collaboration-installer/`.

Resolve the template root from `templateSource` (default: `templates/`).
All update inputs must be rendered from that template tree, not from the
project's own files.

## Step 3: Determine update scope

Only process files belonging to modules listed in
`collaborator.json.modules`.

## Step 4: Process managed files

For each path in `files.managed` (filtered by active modules):
1. Read the corresponding file(s) from `{templateSource}`
2. Apply language selection rules:
   - `zh-CN`: prefer `.zh-CN.*` variant, output to target path without
     `.zh-CN.` suffix; skip the English counterpart. If no `.zh-CN.*`
     variant exists, fall back to the English file.
   - `en` (default): use non-`.zh-CN.*` files; skip `.zh-CN.*` files.
   - Each target path receives exactly ONE language version.
3. Render placeholders:
   - file content: `{project}`, `{org}`
   - path segments or filenames: `_project_`
4. Write to the project (overwrite existing files)
6. Create new template files that do not exist locally
7. Flag files removed from the template source; do not auto-delete them

## Step 5: Process merged files (AI intelligent merge)

For each path in `files.merged` (filtered by active modules):
1. Render the latest template version from `{templateSource}`
2. Read current local file. **If the local file does not exist**,
   write the rendered template directly and skip merge (first-time setup).
3. Analyze both files:
   - Identify **template standard sections**
   - Identify **user customizations** (added sections, modified content)
4. Produce merged result:
   - Template standard sections -> update to latest version
   - User customizations -> preserve in original positions
   - New template sections -> insert at appropriate locations
   - Removed template sections -> flag to user, preserve by default
5. Write merged result

**Merge principles**:
- When in doubt, preserve user content
- Never silently delete user-added content
- If a template section was both updated in template AND modified
  by user, keep user's version and note the template's new version
  in a comment

## Step 6: Process ejected files

For files listed in `files.ejected`:
- **If the local file already exists**: do not touch it (ejected = user owns it).
- **If the local file does not exist** (first-time setup): render from template
  and write it once. Future updates will skip it.

## Step 7: Update collaborator.json

Set `templateVersion` to the template source's current version.
Keep `templateSource` unchanged unless the user explicitly wants to move
to a different template tree.

## Step 8: Sync Codex prompts to global directory

If `.codex/scripts/install-prompts.sh` exists, run it to sync all Codex
commands from `.codex/commands/` to `~/.codex/prompts/`. This ensures
newly rendered commands are immediately available in Codex CLI.

```bash
bash .codex/scripts/install-prompts.sh
```

## Step 9: Output report

Report organized by module and category:
- managed: files updated, new files created, removed files flagged
- merged: files merged, details of what changed
- ejected: files skipped

**STOP**: Do not make other changes to the project.
