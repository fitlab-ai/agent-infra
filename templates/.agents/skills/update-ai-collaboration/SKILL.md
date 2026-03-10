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

Read `collaborator.json` from project root. Extract:
- `project`, `org`
- `language`
- `modules`
- `templateSource`
- `files.managed` / `files.merged` / `files.ejected`

## Step 2: Locate and refresh template source

1. If `~/.ai-collaboration-installer/` does not exist, report error and stop:
   "Template source not found. Please install first:
   curl -fsSL https://raw.githubusercontent.com/fitlab-ai/ai-collaboration-installer/main/install.sh | sh"
2. Run `git -C ~/.ai-collaboration-installer pull` to fetch the latest templates.
3. Record the template source's current commit SHA (`git -C ~/.ai-collaboration-installer rev-parse --short HEAD`).

Resolve the template root from `templateSource` (default: `templates/`).
All update inputs must be rendered from that template tree, not from the
project's own files.

## Step 3: Determine update scope and classify files

Only process files belonging to modules listed in `collaborator.json.modules`.

**File classification priority** (high → low):
1. Paths listed in `files.ejected` → **ejected** (user fully owns, do not touch)
2. Paths or glob patterns in `files.merged` → **merged** (AI intelligent merge)
3. Paths listed in `files.managed` → **managed** (template overwrites)

**Critical**: Even if a file lives inside a managed directory, if it matches
ANY glob pattern in `files.merged`, it MUST use the merged strategy.
Match glob patterns against the file's relative path in the project.

## Step 4: Process managed files

For each template file under a managed directory/path, follow these sub-steps in order:

### 4.0 Exclude merged / ejected files (MUST run first)

When iterating files inside a managed directory, **check each file's target
relative path** against every entry (exact path or glob pattern) in
`files.merged` and `files.ejected`.
**If it matches, skip the file** — it will be handled in Step 5 or Step 6.

> **Example**: `.agents/skills/` is a managed directory, but `files.merged`
> contains `.agents/skills/test/SKILL.*`. When processing that directory:
> - `.agents/skills/commit/SKILL.md` → no merged match → **process as managed**
> - `.agents/skills/test/SKILL.md` → matches `.agents/skills/test/SKILL.*` → **skip, leave for Step 5**
>
> **Common mistake**: batch-processing the entire managed directory first, then
> handling merged files separately. This overwrites merged files with template
> content, destroying user customizations (e.g., filled-in TODOs).

### 4.1 Language selection

Based on the `language` field:
- `zh-CN`: prefer `.zh-CN.*` variant, output to target path without
  `.zh-CN.` suffix; skip the English counterpart. If no `.zh-CN.*`
  variant exists, fall back to the English file.
- `en` (default): use non-`.zh-CN.*` files; skip `.zh-CN.*` files.
- Each target path receives exactly ONE language version.

### 4.2 Render placeholders

Template files use two types of placeholders:

**Content placeholders**: Double-brace placeholders for `project` and `org`
within the template text. During rendering, replace them with the actual values
from collaborator.json's `project` and `org` fields.

**Path placeholders**: `_project_` in file or directory names, replaced with
the project name.

> **Warning**: Never skip rendering and copy template files as-is. Skipping
> rendering leaves unresolved placeholders in the output, causing massive
> spurious changes on the next run and breaking idempotency.

### 4.3 Write

- Overwrite existing local files
- Create new files that exist in the template but not locally
- Flag files removed from the template source; do not auto-delete them

## Step 5: Process merged files (AI intelligent merge)

Render the latest template version (same language selection and placeholder
rendering rules as Step 4), then read the current local file.

**If the local file does not exist** (first-time setup), write the rendered
template directly and skip merge.

If the local file exists, compare the rendered template with the local file:
- Identify **template standard sections** (structure, formatting, general rules)
  and **user customizations** (project-specific content, filled TODOs, etc.)
- Template standard sections → update to latest version
- User customizations → preserve
- New template sections → insert at appropriate locations
- Removed template sections → flag to user, preserve by default

**Merge principles**:
- When in doubt, preserve user content
- Never silently delete user-added content

## Step 6: Process ejected files

- **If the local file already exists**: do not touch it (ejected = user owns it).
- **If the local file does not exist** (first-time setup): render from template
  and write it once. Future updates will skip it.

## Step 7: Update collaborator.json

### Self-update detection

Before updating `templateVersion`, compare the current project's git remote URL
with `~/.ai-collaboration-installer/`'s remote URL. If they match (i.e., the
project IS the template source repository), and steps 4-6 produced no file
changes, skip the `templateVersion` update and report the project as up-to-date.

> **Rationale**: The template source repo has a version tracking loop —
> updating templateVersion → commit → SHA changes → next update needs to change
> templateVersion again. When no substantive file changes occurred, skipping
> this field breaks the cycle.

### Regular update

Set `templateVersion` to the template source's current commit SHA
(recorded in Step 2).
Keep `templateSource` unchanged unless the user explicitly wants to move
to a different template tree.

## Step 8: Verify and output report

**Idempotency check**: Running this command on an already up-to-date project
should produce zero or very few file changes. If managed file changes are
unexpectedly high, pause before committing and spot-check with `git diff`
that the change direction is correct (correct: new template content → local;
wrong: reverting rendered content back to placeholders).

Output the report, then **STOP** — do not make other changes to the project.
