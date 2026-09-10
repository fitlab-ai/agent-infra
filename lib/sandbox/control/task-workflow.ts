import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { readStableFile, SecureFileError, writeAtomicFile } from '../../host-control/secure-fs.ts';

import { TASK_WORKFLOW_COMMANDS, TASK_WORKFLOW_OPERATIONS, type TaskWorkflowOperation, type WorkflowCommand } from '../../task/workflow-command.ts';

export type TaskWorkflowRequest = Readonly<{
  version: 1;
  id: string;
  taskId: string;
  generation: string;
  operation: TaskWorkflowOperation;
  args: readonly string[];
}>;

export function validateTaskWorkflowRequest(value: unknown): TaskWorkflowRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
  const request = value as TaskWorkflowRequest;
  if (Object.keys(request).sort().join(',') !== 'args,generation,id,operation,taskId,version'
    || request.version !== 1 || typeof request.id !== 'string' || !/^[a-f0-9-]{16,64}$/u.test(request.id)
    || typeof request.taskId !== 'string' || !/^TASK-\d{8}-\d{6}$/u.test(request.taskId)
    || typeof request.generation !== 'string' || !request.generation
    || !Object.hasOwn(TASK_WORKFLOW_COMMANDS, request.operation)
    || !Array.isArray(request.args) || request.args.length < 2 || request.args.length > 128
    || !request.args.every((arg) => typeof arg === 'string' && !/[\r\n]/u.test(arg))
    || request.args[0] !== request.taskId) throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
  const [, selector] = TASK_WORKFLOW_COMMANDS[request.operation];
  if (selector !== null && request.args[1] !== selector) throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
  return request;
}

/** Preserve argv verbatim; the domain command owns option parsing and validation. */
export function createTaskWorkflowRequest(
  command: WorkflowCommand | undefined,
  args: readonly string[],
  taskId: string,
  generation: string
): TaskWorkflowRequest {
  const operation = TASK_WORKFLOW_OPERATIONS.find((key) => {
    const [name, selector] = TASK_WORKFLOW_COMMANDS[key];
    return name === command && (selector === null || selector === args[1]);
  });
  if (!operation) throw new Error('TASK_WORKFLOW_OPERATION_UNSUPPORTED');
  return validateTaskWorkflowRequest({ version: 1, id: randomUUID(), taskId, generation, operation, args: [...args] });
}

export function canonicalArtifactName(value: string): boolean {
  return /^(?:analysis|plan|code|review-analysis|review-plan|review-code)(?:-r[1-9]\d*)?\.md$/u.test(value)
    && path.basename(value) === value;
}

function assertTaskArtifactDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new SecureFileError('TASK_ARTIFACT_WRITE_DENIED', 'task directory is unavailable');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SecureFileError('TASK_ARTIFACT_WRITE_DENIED', 'task directory must be a real directory');
  }
  return resolved;
}

export async function readTaskArtifact(
  taskDir: string,
  input: Readonly<{
    artifact: string;
    expectedSha256?: string;
  }>
): Promise<Readonly<{ artifact: string; bytes: Buffer; sha256: string }>> {
  if (!canonicalArtifactName(input.artifact)) throw new SecureFileError('TASK_ARTIFACT_WRITE_DENIED', 'artifact must be a canonical top-level basename');
  const root = assertTaskArtifactDirectory(taskDir);
  const candidate = path.join(root, input.artifact);
  if (path.dirname(candidate) !== root) throw new SecureFileError('TASK_ARTIFACT_WRITE_DENIED', 'artifact escapes task directory');
  const stable = await readStableFile(candidate, {
    maxBytes: 1024 * 1024,
    ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {})
  });
  return { artifact: input.artifact, bytes: stable.bytes, sha256: stable.sha256 };
}

export async function writeTaskArtifact(
  taskDir: string,
  artifact: Readonly<{ artifact: string; bytes: Buffer; expectedSha256?: string }>
): Promise<void> {
  if (!canonicalArtifactName(artifact.artifact)) throw new SecureFileError('TASK_ARTIFACT_WRITE_DENIED', 'artifact must be a canonical top-level basename');
  const root = assertTaskArtifactDirectory(taskDir);
  const target = path.join(root, artifact.artifact);
  if (path.dirname(target) !== root) throw new SecureFileError('TASK_ARTIFACT_WRITE_DENIED', 'artifact escapes task directory');
  await writeAtomicFile(target, artifact.bytes, 0o600, artifact.expectedSha256);
}
