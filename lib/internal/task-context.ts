import { parseTaskScope } from '../task/command-options.ts';
import { resolveTaskContext } from '../task/resolve-ref.ts';

const USAGE = `Usage: agent-infra-internal task-context resolve [<task-ref> | --task <task-ref> | -t <task-ref>]\n`;

function fail(code: string, message: string, usage = false): void {
  process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code, message } })}\n`);
  if (usage) process.stderr.write(USAGE);
  process.exitCode = 1;
}

function taskContext(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  if (args[0] !== 'resolve') { fail('TASK_CONTEXT_PAYLOAD_INVALID', "operation 'resolve' is required", true); return; }
  let scope;
  try {
    scope = parseTaskScope(args.slice(1));
  } catch (error) {
    fail('TASK_CONTEXT_PAYLOAD_INVALID', error instanceof Error ? error.message : String(error), true);
    return;
  }
  if (scope.positionals.length > 1 || (scope.explicit && scope.positionals.length > 0)) {
    fail('TASK_CONTEXT_PAYLOAD_INVALID', 'task ref must be provided once', true);
    return;
  }
  const taskRef = scope.taskRef ?? scope.positionals[0];
  const result = resolveTaskContext(taskRef);
  if (!result.ok) { fail(result.code, result.message); return; }
  process.stdout.write(`${JSON.stringify({
    status: 'resolved', changed: false, taskId: result.taskId, taskDir: result.taskDir,
    taskMdPath: result.taskMdPath, taskState: result.state, error: null
  })}\n`);
}

export { taskContext };
