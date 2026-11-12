import {
  PUBLIC_CLI_SELECTOR_ALIASES
} from '../internal/cli-route-inventory.ts';

const USAGE = `Usage: ai task <command> [options]

Commands:
  cat [--task <ref> | -t <ref>] <artifact | N> Print a task artifact (by name or number)
  decisions, d [--task <ref> | -t <ref>] [--item <selector> | -i <selector>] List review decisions, or show one item's detail
  files [--task <ref> | -t <ref>]        List artifacts in a task dir (numbered)
  grep [--current | --task <ref> | -t <ref>] <pattern> Literal search in the current or selected task
  issue-body [--task <ref> | -t <ref>] [--template <path>] Print a deterministic Issue body from task.md
  log [--task <ref> | -t <ref>]          Render a task's activity log as a timeline
  ls [--all | --blocked | --completed]   List tasks (default: active)
  show [--task <ref> | -t <ref>]         Print a task.md
  status [--task <ref> | -t <ref>]       Aggregated status view (metadata / artifacts / git / platform)

Examples:
  ai task cat analysis
  ai task cat --task 11 analysis
  ai task decisions --task 11
  ai task decisions --item 1
  ai task d --task 11 --item PL-3 --format markdown
  ai task files --task 11
  ai task grep resolveArtifact
  ai task grep resolveArtifact --current
  ai task grep resolveArtifact --task 11
  ai task issue-body --task 11
  ai task issue-body --task 11 --template .github/ISSUE_TEMPLATE/05_other.yml
  ai task log --task 11
  ai task ls
  ai task show --task 11
  ai task show --task TASK-20260612-162737
  ai task status --task 11

Run 'ai task <command> --help' for details.`;
type TaskCommand = (args: string[]) => Promise<void>;

const TASK_COMMANDS = new Map<string, TaskCommand>([
  ['cat', async (args) => {
    const { cat } = await import('./commands/cat.ts');
    cat(args);
  }],
  ['decisions', async (args) => {
    const { decisions } = await import('./commands/decisions.ts');
    decisions(args);
  }],
  ['files', async (args) => {
    const { files } = await import('./commands/files.ts');
    files(args);
  }],
  ['grep', async (args) => {
    const { grep } = await import('./commands/grep.ts');
    grep(args);
  }],
  ['issue-body', async (args) => {
    const { issueBody } = await import('./commands/issue-body.ts');
    issueBody(args);
  }],
  ['log', async (args) => {
    const { log } = await import('./commands/log.ts');
    log(args);
  }],
  ['ls', async (args) => {
    const { ls } = await import('./commands/ls.ts');
    ls(args);
  }],
  ['show', async (args) => {
    const { show } = await import('./commands/show.ts');
    show(args);
  }],
  ['status', async (args) => {
    const { status } = await import('./commands/status.ts');
    status(args);
  }]
]);

export async function runTask(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (!subcommand) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const routeSelector: string = PUBLIC_CLI_SELECTOR_ALIASES.task[subcommand as keyof typeof PUBLIC_CLI_SELECTOR_ALIASES.task] ?? subcommand;
  const command = TASK_COMMANDS.get(routeSelector);
  if (!command) {
    process.stderr.write(`Unknown task command: ${subcommand}\n\n`);
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  await command(rest);
}
