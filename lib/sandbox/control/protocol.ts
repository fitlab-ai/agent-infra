export const SANDBOX_CONTROL_MAX_BYTES = 64 * 1024;
export const SANDBOX_CONTROL_FAMILIES = ['task-lifecycle', 'task-orchestration'] as const;

export type SandboxControlFamily = typeof SANDBOX_CONTROL_FAMILIES[number];

export type SandboxControlManifest = Readonly<{
  version: 1;
  repoRoot: string;
  project: string;
  container: string;
  branch: string;
  mode: 'task-bound' | 'branch-only';
  taskId: string | null;
  token: string;
  channelDir: string;
}>;

export type SandboxControlRequest = Readonly<{
  version: 1;
  id: string;
  token: string;
  family: SandboxControlFamily;
  args: string[];
}>;

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
  const request = value as Partial<SandboxControlRequest>;
  if (
    request.version !== 1
    || typeof request.id !== 'string'
    || !/^[a-f0-9-]{16,64}$/.test(request.id)
    || request.token !== manifest.token
    || typeof request.family !== 'string'
    || !isSandboxControlFamily(request.family)
    || !Array.isArray(request.args)
    || !request.args.every((arg) => typeof arg === 'string')
  ) {
    throw new Error('SANDBOX_CONTROL_REQUEST_INVALID: request schema or authorization is invalid');
  }
  if (manifest.mode !== 'task-bound' || !manifest.taskId) {
    throw new Error('SANDBOX_CONTROL_BRANCH_ONLY: branch-only sandboxes cannot coordinate tasks');
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > SANDBOX_CONTROL_MAX_BYTES) {
    throw new Error('SANDBOX_CONTROL_REQUEST_TOO_LARGE: request exceeds the control limit');
  }
  return request as SandboxControlRequest;
}

export function bindSandboxControlTask(
  request: SandboxControlRequest,
  taskId: string
): string[] {
  if (request.args.length === 0) {
    throw new Error('SANDBOX_CONTROL_REQUEST_INVALID: command arguments are required');
  }
  return [taskId, ...request.args.slice(1)];
}
