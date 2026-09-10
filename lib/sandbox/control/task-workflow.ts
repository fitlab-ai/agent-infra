import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { readStableFile, SecureFileError, writeAtomicFile } from '../../host-control/secure-fs.ts';

import { TASK_WORKFLOW_COMMANDS, TASK_WORKFLOW_OPERATIONS, type TaskWorkflowOperation, type WorkflowCommand } from '../../task/workflow-command.ts';

export type ProjectionAncestorIdentity = Readonly<{
  path: string;
  realpath: string;
  dev: number;
  ino: number;
  mountIdentity: string;
}>;

export type TaskProjectionManifest = Readonly<{
  version: 1;
  taskId: string;
  generation: string;
  projectionRoot: string;
  authoritativeTaskDir: string;
  topology: Readonly<{ verified: boolean; ancestors: readonly ProjectionAncestorIdentity[] }>;
}>;

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

export function captureProjectionTopology(root: string): readonly ProjectionAncestorIdentity[] {
  const ancestors: ProjectionAncestorIdentity[] = [];
  let current = fs.realpathSync.native(path.resolve(root));
  while (true) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('TASK_PROJECTION_TOPOLOGY_UNVERIFIED');
    const realpath = fs.realpathSync.native(current);
    ancestors.push({ path: current, realpath, dev: stat.dev, ino: stat.ino, mountIdentity: String(stat.dev) });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

export function verifyProjectionTopology(manifest: TaskProjectionManifest): void {
  if (!manifest.topology.verified || manifest.topology.ancestors.length === 0) throw new Error('TASK_PROJECTION_TOPOLOGY_UNVERIFIED');
  for (const expected of manifest.topology.ancestors) {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(expected.path); } catch { throw new Error('TASK_PROJECTION_TOPOLOGY_UNVERIFIED'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('TASK_PROJECTION_TOPOLOGY_UNVERIFIED');
    if (stat.dev !== expected.dev || stat.ino !== expected.ino || fs.realpathSync.native(expected.path) !== expected.realpath) {
      throw new Error('TASK_PROJECTION_TOPOLOGY_UNVERIFIED');
    }
  }
}

function assertAuthoritativeDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('TASK_ARTIFACT_WRITE_DENIED');
}

/** Publish the already-validated buffer; never reopen an agent-controlled candidate. */
export async function landProjectionArtifact(
  manifest: TaskProjectionManifest,
  artifact: Readonly<{ artifact: string; bytes: Buffer }>
): Promise<void> {
  if (!canonicalArtifactName(artifact.artifact)) throw new Error('TASK_ARTIFACT_WRITE_DENIED');
  await writeAtomicFile(path.join(manifest.authoritativeTaskDir, artifact.artifact), artifact.bytes);
}

export async function readProjectionArtifact(
  manifest: TaskProjectionManifest,
  input: Readonly<{
    artifact: string;
    expectedSha256?: string;
  }>
): Promise<Readonly<{ artifact: string; bytes: Buffer; sha256: string }>> {
  if (!canonicalArtifactName(input.artifact)) throw new SecureFileError('TASK_ARTIFACT_WRITE_DENIED', 'artifact must be a canonical top-level basename');
  verifyProjectionTopology(manifest);
  assertAuthoritativeDirectory(manifest.authoritativeTaskDir);
  const candidate = path.join(manifest.projectionRoot, input.artifact);
  const root = path.resolve(manifest.projectionRoot);
  if (path.dirname(candidate) !== root) throw new SecureFileError('TASK_ARTIFACT_WRITE_DENIED', 'artifact escapes projection root');
  const stable = await readStableFile(candidate, {
    maxBytes: 1024 * 1024,
    ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {})
  });
  return { artifact: input.artifact, bytes: stable.bytes, sha256: stable.sha256 };
}
