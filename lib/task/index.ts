import {
  PUBLIC_CLI_ROUTE_SELECTORS,
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
const TASK_OPERATIONS = PUBLIC_CLI_ROUTE_SELECTORS.task;

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
  if (!TASK_OPERATIONS.includes(routeSelector as typeof TASK_OPERATIONS[number])) {
    process.stderr.write(`Unknown task command: ${subcommand}\n\n`);
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  switch (routeSelector) {
    case 'cat': {
      const { cat } = await import('./commands/cat.ts');
      cat(rest);
      break;
    }
    case 'decisions': {
      const { decisions } = await import('./commands/decisions.ts');
      decisions(rest);
      break;
    }
    case 'files': {
      const { files } = await import('./commands/files.ts');
      files(rest);
      break;
    }
    case 'grep': {
      const { grep } = await import('./commands/grep.ts');
      grep(rest);
      break;
    }
    case 'issue-body': {
      const { issueBody } = await import('./commands/issue-body.ts');
      issueBody(rest);
      break;
    }
    case 'log': {
      const { log } = await import('./commands/log.ts');
      log(rest);
      break;
    }
    case 'ls': {
      const { ls } = await import('./commands/ls.ts');
      ls(rest);
      break;
    }
    case 'show': {
      const { show } = await import('./commands/show.ts');
      show(rest);
      break;
    }
    case 'status': {
      const { status } = await import('./commands/status.ts');
      status(rest);
      break;
    }
    default:
      process.stderr.write(`Unknown task command: ${subcommand}\n\n`);
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = 1;
  }
}
