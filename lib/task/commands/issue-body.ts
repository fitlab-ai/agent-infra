import fs from 'node:fs';
import { resolveTaskRef } from '../resolve-ref.ts';
import { extractTitle } from '../frontmatter.ts';
import { extractSection, findSectionHeading } from '../sections.ts';
import { renderTemplateBody, PLACEHOLDER } from '../issue-form.ts';
import type { TaskFields } from '../issue-form.ts';

const USAGE = `Usage: ai task issue-body <N | #N | TASK-id> [--template <path>]

Print a deterministic Issue body extracted from a task's task.md.
  <ref>               Bare numeric / '#N' short id, or a full TASK-YYYYMMDD-HHMMSS id.
  --template <path>   Render the final body for the given GitHub Issue Form (scenario A);
                      without it, print the default '描述 + 需求' body (scenario B).

Only the task title, '## 描述' and '## 需求' sections are ever emitted; the rest of
task.md (scaffolding sections, placeholders) is never written to the body.
`;

const DESCRIPTION_ALIASES = ['描述', 'Description'];
const REQUIREMENTS_ALIASES = ['需求', 'Requirements'];

/**
 * Build the scenario B default body, mirroring whichever heading language the
 * task.md actually uses, with empty sections falling back to `N/A`.
 */
function buildDefaultBody(content: string): string {
  const descHeading = findSectionHeading(content, DESCRIPTION_ALIASES);
  const reqHeading = findSectionHeading(content, REQUIREMENTS_ALIASES);
  const description = extractSection(content, DESCRIPTION_ALIASES) || PLACEHOLDER;
  const requirements = extractSection(content, REQUIREMENTS_ALIASES) || PLACEHOLDER;
  return `## ${descHeading}\n\n${description}\n\n## ${reqHeading}\n\n${requirements}\n`;
}

function readTaskFields(content: string): TaskFields {
  return {
    title: extractTitle(content),
    description: extractSection(content, DESCRIPTION_ALIASES),
    requirements: extractSection(content, REQUIREMENTS_ALIASES)
  };
}

function issueBody(args: string[] = []): void {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    if (args.length === 0) process.exitCode = 1;
    return;
  }

  let ref: string | undefined;
  let templatePath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--template') {
      templatePath = args[i + 1];
      i += 1;
    } else if (ref === undefined) {
      ref = arg;
    }
  }

  if (!ref) {
    process.stderr.write('ai task issue-body: missing task ref\n');
    process.exitCode = 1;
    return;
  }
  if (templatePath === undefined && args.includes('--template')) {
    process.stderr.write('ai task issue-body: --template requires a path\n');
    process.exitCode = 1;
    return;
  }

  const resolved = resolveTaskRef(ref);
  if (!resolved.ok) {
    process.stderr.write(`ai task issue-body: ${resolved.message}\n`);
    process.exitCode = 1;
    return;
  }

  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');

  if (templatePath !== undefined) {
    let formText: string;
    try {
      formText = fs.readFileSync(templatePath, 'utf8');
    } catch (e) {
      process.stderr.write(`ai task issue-body: cannot read template '${templatePath}': ${(e as Error).message}\n`);
      process.exitCode = 1;
      return;
    }
    try {
      process.stdout.write(renderTemplateBody(formText, readTaskFields(content)));
    } catch (e) {
      process.stderr.write(`ai task issue-body: cannot render template '${templatePath}': ${(e as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  process.stdout.write(buildDefaultBody(content));
}

export { issueBody, buildDefaultBody };
