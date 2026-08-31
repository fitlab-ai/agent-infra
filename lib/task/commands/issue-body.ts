import fs from 'node:fs';
import { parseTaskScope } from '../command-options.ts';
import { resolveTaskContext } from '../resolve-ref.ts';
import { extractTitle } from '../frontmatter.ts';
import { extractSection, findSectionHeading } from '../sections.ts';
import { renderTemplateBody, PLACEHOLDER } from '../issue-form.ts';
import type { TaskFields } from '../issue-form.ts';

const USAGE = `Usage: ai task issue-body [--task <ref> | -t <ref>] [--template <path>]

Print a deterministic Issue body extracted from a task's task.md.
  Omit the scope        Resolve the unique active task for the current branch.
  --task/-t <ref>       Bare numeric short id, or a full TASK-YYYYMMDD-HHMMSS id.
  --template <path>   Render the final body for the given GitHub Issue Form (scenario A);
                      without it, print the default '任务输入 + 描述 + 需求' body (scenario B).

Only the task title, '## 任务输入', '## 描述' and '## 需求' sections are ever
emitted; the rest of task.md is never written to the body.
`;

const TASK_INPUT_ALIASES = ['任务输入', 'Task Input'];
const DESCRIPTION_ALIASES = ['描述', 'Description'];
const REQUIREMENTS_ALIASES = ['需求', 'Requirements'];

/**
 * Build the scenario B default body, mirroring whichever heading language the
 * task.md actually uses, with empty sections falling back to `N/A`.
 */
function buildDefaultBody(content: string): string {
  const taskInputHeading = findSectionHeading(content, TASK_INPUT_ALIASES);
  const descHeading = findSectionHeading(content, DESCRIPTION_ALIASES);
  const reqHeading = findSectionHeading(content, REQUIREMENTS_ALIASES);
  const taskInput = extractSection(content, TASK_INPUT_ALIASES) || PLACEHOLDER;
  const description = extractSection(content, DESCRIPTION_ALIASES) || PLACEHOLDER;
  const requirements = extractSection(content, REQUIREMENTS_ALIASES) || PLACEHOLDER;
  return `## ${taskInputHeading}\n\n${taskInput}\n\n## ${descHeading}\n\n${description}\n\n## ${reqHeading}\n\n${requirements}\n`;
}

function readTaskFields(content: string): TaskFields {
  return {
    title: extractTitle(content),
    description: extractSection(content, DESCRIPTION_ALIASES),
    requirements: extractSection(content, REQUIREMENTS_ALIASES),
    taskInput: extractSection(content, TASK_INPUT_ALIASES),
    taskInputHeading: findSectionHeading(content, TASK_INPUT_ALIASES)
  };
}

function issueBody(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  let templatePath: string | undefined;
  const scopeArgs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--template') {
      templatePath = args[i + 1];
      i += 1;
    } else { scopeArgs.push(arg); }
  }
  if (templatePath === undefined && args.includes('--template')) {
    process.stderr.write('ai task issue-body: --template requires a path\n');
    process.exitCode = 1;
    return;
  }

  let scope;
  try { scope = parseTaskScope(scopeArgs); } catch (error) {
    process.stderr.write(`ai task issue-body: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; return;
  }
  if (scope.positionals.length > 0) {
    process.stderr.write('ai task issue-body: positional task ref is not supported; use --task <ref> or -t <ref>\n'); process.exitCode = 1; return;
  }
  const resolved = resolveTaskContext(scope.taskRef);
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
