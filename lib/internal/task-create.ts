import fs from 'node:fs';
import path from 'node:path';

import { requestSandboxTaskCreate } from '../sandbox/control/client.ts';
import { SANDBOX_CONTROL_MAX_BYTES } from '../sandbox/control/protocol.ts';
import { validateTaskCreateCandidate } from '../task/create.ts';
import { createTask, type TaskCreateResult } from '../task/create-service.ts';

function failed(code: string, message: string): TaskCreateResult {
  return {
    status: 'failed', changed: false, task: { id: null, shortId: null }, issue: null,
    operations: [], warnings: [], error: { code, message, retryable: false }
  };
}

function output(result: TaskCreateResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'blocked' ? 2 : result.status === 'failed' ? 1 : 0;
}

function taskCreate(args: string[]): void {
  const inputIndex = args.indexOf('--input');
  const input = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
  if (!input || args.length !== 2 || inputIndex !== 0) {
    output(failed('TASK_CREATE_PAYLOAD_INVALID', 'Usage: agent-infra-internal task-create --input <candidate.json>'));
    return;
  }
  try {
    const inputPath = path.resolve(input);
    const stat = fs.lstatSync(inputPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('TASK_CREATE_INPUT_INVALID: input must be a regular file');
    if (stat.size > SANDBOX_CONTROL_MAX_BYTES) throw new Error('TASK_CREATE_INPUT_TOO_LARGE: input exceeds the control limit');
    const candidate = validateTaskCreateCandidate(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
    if (process.env.AGENT_INFRA_CONTROL_TOKEN) {
      const response = requestSandboxTaskCreate({ candidate });
      process.stdout.write(response.stdout);
      process.stderr.write(response.stderr);
      process.exitCode = response.exitCode;
      return;
    }
    output(createTask(candidate, { repoRoot: process.cwd() }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)/.exec(message)?.[1] ?? 'TASK_CREATE_INPUT_INVALID';
    output(failed(code, message));
  }
}

export { taskCreate };
