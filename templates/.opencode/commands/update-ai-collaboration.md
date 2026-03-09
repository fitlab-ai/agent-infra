---
description: Update project AI collaboration configuration by re-rendering templates/
agent: general
subtask: false
---

Update existing AI collaboration configuration by re-rendering from `templates/`.

1. **Read current configuration**

Read `collaborator.json` from the project root.

If it does not exist, respond:
"No existing configuration found. Run `ai-collaboration-installer init` first."
Then STOP.

2. **Locate and refresh the template source**

- If `source` is `self`, use the current repository.
- Otherwise, run `git -C ~/.ai-collaboration-installer pull` to fetch latest templates, then use `~/.ai-collaboration-installer/`.
- If `~/.ai-collaboration-installer/` does not exist, report error and stop.
- Resolve the template root from `templateSource` (default: `templates/`).

3. **Render managed files**

For files in `files.managed`:
- render from `templates/`
- apply language selection
- replace `{project}`, `{org}`, and `_project_`
- overwrite local managed files
- create new template files
- flag files removed from the template source instead of deleting them

4. **Merge merged files**

For files in `files.merged`:
- render the latest template version
- if the local file does not exist, write the rendered template directly (first-time setup)
- otherwise, compare it with the local file
- update template-owned sections
- preserve user customizations
- when uncertain, keep user content and note the conflict

5. **Process ejected files**

- If the local file already exists: do not modify it.
- If the local file does not exist (first-time setup): render from template once.

6. **Refresh collaborator.json**

Update `templateVersion` and keep `templateSource` unchanged unless the user
explicitly wants a different template tree.

7. **Sync Codex prompts**

If `.codex/scripts/install-prompts.sh` exists, run it to sync commands
to `~/.codex/prompts/`.

8. **Report changes**

List updated managed files, merged files, skipped ejected files, new files,
and files that need manual follow-up.

**Next step:** Review the updated configuration files.
