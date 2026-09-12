import { parseArtifactCommand, executeArtifactCommand } from '../task/artifact-command.ts';
import { ensureInternalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = `Usage: agent-infra-internal task-artifact <N | TASK-id> inspect --family <family>\n       agent-infra-internal task-artifact <N | TASK-id> init --family <family> --artifact <artifact> [--locale <zh-CN|en>]\n       agent-infra-internal task-artifact <N | TASK-id> repair --family <family> --artifact <artifact> --expected-sha256 <sha256> --expected-semantic-digest <digest>\n       agent-infra-internal task-artifact <N | TASK-id> finalize-local --family <analysis|plan|code> --artifact <artifact>\n\nInspect, initialize, repair, or finalize a workflow artifact without changing task state.\n`;


function taskArtifact(args: string[] = []): void {
  if (!ensureInternalHandlerRoute('task-artifact', args)) return;
  if (args[0] === '--help' || args[0] === '-h') { process.stdout.write(USAGE); return; }
  let command;
  try { command = parseArtifactCommand(args); }
  catch (error) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: {
      code: 'ARTIFACT_PAYLOAD_INVALID', message: error instanceof Error ? error.message : String(error)
    } })}\n`);
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const result = executeArtifactCommand(command);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'refused') process.exitCode = 1;
  else if (result.status === 'failed') process.exitCode = command.operation === 'inspect' ? 2 : 1;
}

export { taskArtifact };
