---
description: Update project AI collaboration config by re-rendering latest templates/
usage: /prompts:{project}-update-ai-collaboration
---

# Update Project

Update the current project's AI collaboration infrastructure and project governance to match the latest ai-collaboration-installer templates. Intelligently merges template changes while preserving project-specific customizations.

## Step 1: Read project config

Read `collaborator.json` from project root.
Extract: source, project, org, language, modules, templateSource, files (managed/merged/ejected lists).

## Step 2: Locate and refresh template source

If `source` is `self` (ai-collaboration-installer updating itself), use current repository.
Otherwise:
1. If `~/.ai-collaboration-installer/` does not exist, report error and stop:
   "Template source not found. Please install first:
   `curl -fsSL https://raw.githubusercontent.com/fitlab-ai/ai-collaboration-installer/main/install.sh | sh`"
2. Run `git -C ~/.ai-collaboration-installer pull` to fetch the latest templates.
3. Read from `~/.ai-collaboration-installer/`.

Resolve the template root from `templateSource` (default: `templates/`).

## Step 3: Determine update scope

Only process files belonging to modules listed in `collaborator.json.modules`.

## Step 4: Process managed files

For each path in `files.managed` (filtered by active modules):
1. Render corresponding file(s) from `{templateSource}`
2. Select language version based on `language` setting
3. Replace `{project}` / `{org}` in file content and `_project_` in paths
4. Write to project (overwrite existing)
6. New files in template that don't exist locally -> create them
7. Files removed from the template source -> flag for user, do not auto-delete

## Step 5: Process merged files (AI intelligent merge)

For each path in `files.merged` (filtered by active modules):
1. Render the latest template from `{templateSource}`
2. Read current local file. **If the local file does not exist**,
   write the rendered template directly and skip merge (first-time setup).
3. Analyze both files: identify template standard sections and user customizations
4. Produce merged result preserving user customizations
5. Write merged result

**Merge principles**:
- When in doubt, preserve user content
- Never silently delete user-added content
- If a template section was both updated and modified by user, keep user's version and note changes

## Step 6: Process ejected files

For files listed in `files.ejected`:
- **If the local file already exists**: do not touch it.
- **If the local file does not exist** (first-time setup): render from template once.

## Step 7: Update collaborator.json

Set `templateVersion` to template source's current version.
Keep `templateSource` unchanged unless the user explicitly wants a different template tree.

## Step 8: Sync Codex prompts

If `.codex/scripts/install-prompts.sh` exists, run it to sync commands to `~/.codex/prompts/`.

## Step 9: Output report

Report organized by module and category:
- managed: files updated, new files created, removed files flagged
- merged: files merged, details of what changed
- ejected: files skipped

**STOP**: Do not make other changes to the project.
