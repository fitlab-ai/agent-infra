import { validateTaskCreateCandidate, type TaskCreateCandidateV1 } from '../../task/create.ts';

export const SANDBOX_CONTROL_MAX_BYTES = 64 * 1024;
export const SANDBOX_CONTROL_FAMILIES = ['task-lifecycle', 'task-orchestration', 'task-create'] as const;

export type SandboxControlFamily = typeof SANDBOX_CONTROL_FAMILIES[number];

export type SandboxControlManifest = Readonly<{
  version: 2;
  repoRoot: string;
  worktreeRoot: string;
  project: string;
  container: string;
  branch: string;
  mode: 'task-bound' | 'branch-only';
  taskId: string | null;
  token: string;
  channelDir: string;
}>;

export type SandboxTaskCommandRequest = Readonly<{
  version: 1;
  id: string;
  token: string;
  family: 'task-lifecycle' | 'task-orchestration';
  args: string[];
}>;

export type SandboxTaskCreateRequest = Readonly<{
  version: 1;
  id: string;
  token: string;
  family: 'task-create';
  candidate: TaskCreateCandidateV1;
}>;

export type SandboxControlRequest = SandboxTaskCommandRequest | SandboxTaskCreateRequest;

export type SandboxControlResponse = Readonly<{
  version: 1;
  id: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export function isSandboxControlFamily(value: string): value is SandboxControlFamily {
  return SANDBOX_CONTROL_FAMILIES.includes(value as SandboxControlFamily);
}

export function validateSandboxControlRequest(
  value: unknown,
  manifest: SandboxControlManifest
): SandboxControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SANDBOX_CONTROL_REQUEST_INVALID: request must be an object');
  }
  const request = value as Record<string, unknown>;
  if (
    request.version !== 1
    || typeof request.id !== 'string'
    || !/^[a-f0-9-]{16,64}$/.test(request.id)
    || request.token !== manifest.token
    || typeof request.family !== 'string'
    || !isSandboxControlFamily(request.family)
  ) {
    throw new Error('SANDBOX_CONTROL_REQUEST_INVALID: request schema or authorization is invalid');
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > SANDBOX_CONTROL_MAX_BYTES) {
    throw new Error('SANDBOX_CONTROL_REQUEST_TOO_LARGE: request exceeds the control limit');
  }
  if (request.family === 'task-create') {
    const keys = Object.keys(request).sort().join(',');
    if (keys !== ['candidate', 'family', 'id', 'token', 'version'].sort().join(',')) {
      throw new Error('SANDBOX_CONTROL_REQUEST_INVALID: request schema or authorization is invalid');
    }
    return { ...request, candidate: validateTaskCreateCandidate(request.candidate) } as SandboxTaskCreateRequest;
  }
  const keys = Object.keys(request).sort().join(',');
  if (
    keys !== ['args', 'family', 'id', 'token', 'version'].sort().join(',')
    || !Array.isArray(request.args)
    || !request.args.every((arg) => typeof arg === 'string')
  ) {
    throw new Error('SANDBOX_CONTROL_REQUEST_INVALID: request schema or authorization is invalid');
  }
  if (manifest.mode !== 'task-bound' || !manifest.taskId) {
    throw new Error('SANDBOX_CONTROL_BRANCH_ONLY: branch-only sandboxes cannot coordinate tasks');
  }
  if (
    request.family === 'task-orchestration'
    && request.args.some((arg) => arg === '--git-worktree-root' || arg.startsWith('--git-worktree-root='))
  ) {
    throw new Error('SANDBOX_CONTROL_REQUEST_INVALID: worktree binding is reserved for the control broker');
  }
  return request as SandboxTaskCommandRequest;
}

export function bindSandboxControlTask(
  request: SandboxControlRequest,
  taskId: string
): string[] {
  if (request.family === 'task-create') {
    throw new Error('SANDBOX_CONTROL_REQUEST_INVALID: task-create requests do not bind a current task');
  }
  if (request.args.length === 0) {
    throw new Error('SANDBOX_CONTROL_REQUEST_INVALID: command arguments are required');
  }
  return [taskId, ...request.args.slice(1)];
}
