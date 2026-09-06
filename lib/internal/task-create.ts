import fs from 'node:fs';
import path from 'node:path';

import {
  classifySandboxControlEnvironment,
  requestSandboxTaskCreate,
  SandboxControlClientError
} from '../sandbox/control/client.ts';
import { SANDBOX_CONTROL_MAX_BYTES } from '../sandbox/control/protocol.ts';
import { validateTaskCreateCandidate } from '../task/create.ts';
import {
  createTask,
  parseTaskCreateResult,
  projectTaskCreateResult,
  taskCreateExitCode,
  taskCreateFailure,
  type TaskCreateControl,
  type TaskCreateResult
} from '../task/create-service.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

function failed(code: string, message: string, retryable = false, control?: TaskCreateControl): TaskCreateResult {
  return taskCreateFailure({ code, message, retryable }, control);
}

function output(result: TaskCreateResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = taskCreateExitCode(result);
}

function clientErrorControl(error: SandboxControlClientError): TaskCreateControl {
  return {
    requestId: error.requestId,
    accepted: error.accepted,
    recovery: error.accepted ? 'same-request-id' : error.detail.retryable ? 'new-request-id' : 'none'
  };
}

function parseControlledResult(response: ReturnType<typeof requestSandboxTaskCreate>): TaskCreateResult {
  if (response.phase !== 'completed' || response.error !== null) {
    return failed(
      'SANDBOX_CONTROL_RESPONSE_INVALID',
      'SANDBOX_CONTROL_RESPONSE_INVALID: completed task-create response is invalid',
      false,
      { requestId: response.id, accepted: true, recovery: 'same-request-id' }
    );
  }
  let result: TaskCreateResult;
  try {
    result = parseTaskCreateResult(JSON.parse(response.stdout));
  } catch {
    return failed(
      'TASK_CREATE_RESULT_INVALID',
      'TASK_CREATE_RESULT_INVALID: task-create result payload is invalid',
      false,
      { requestId: response.id, accepted: true, recovery: 'same-request-id' }
    );
  }
  if (!result.control || result.control.requestId !== response.id || result.control.accepted !== true) {
    return failed(
      'TASK_CREATE_RESULT_INVALID',
      'TASK_CREATE_RESULT_INVALID: controlled task-create result is missing request evidence',
      false,
      { requestId: response.id, accepted: true, recovery: 'same-request-id' }
    );
  }
  process.stderr.write(response.stderr);
  return result;
}

async function taskCreate(args: string[]): Promise<void> {
  if (!ensureInternalHandlerRoute('task-create', args)) return;
  const inputSelector = args.includes('--input') ? 'input' : '';
  const inputIndex = internalHandlerRoute('task-create', 'input', inputSelector) ? args.indexOf('--input') : -1;
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
    const environment = classifySandboxControlEnvironment();
    if (environment.kind === 'invalid') {
      output(failed(environment.code ?? 'TASK_CONTROL_TRANSPORT_INVALID', environment.message ?? 'sandbox client control configuration is invalid'));
      return;
    }
    if (environment.kind === 'controlled') {
      const response = requestSandboxTaskCreate({ candidate });
      if (response.phase === 'rejected') {
        const accepted = response.error?.code === 'SANDBOX_CONTROL_RESULT_UNKNOWN';
        output(failed(
          response.error?.code ?? 'SANDBOX_CONTROL_REJECTED',
          response.error?.message ?? response.stderr,
          response.error?.retryable ?? false,
          {
            requestId: response.id,
            accepted,
            recovery: accepted ? 'same-request-id' : response.error?.retryable ? 'new-request-id' : 'none'
          }
        ));
        return;
      }
      output(parseControlledResult(response));
      return;
    }
    output(await createTask(candidate, { repoRoot: process.cwd() }));
  } catch (error) {
    if (error instanceof SandboxControlClientError) {
      output(failed(error.detail.code, error.detail.message, error.detail.retryable, clientErrorControl(error)));
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)/.exec(message)?.[1] ?? 'TASK_CREATE_INPUT_INVALID';
    output(failed(code, message));
  }
}

export { taskCreate };
