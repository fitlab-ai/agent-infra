import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { readStableFile, SecureFileError, writeAtomicFile } from '../../host-control/secure-fs.ts';

export const TASK_WORKFLOW_OPERATIONS = Object.freeze([
  'artifact-inspect', 'artifact-finalize-local', 'review-finalize-summary', 'event',
  'ledger-finding-response', 'ledger-finding-review', 'ledger-finding-upsert',
  'decision-next-id', 'decision-upsert', 'invalidation-reconcile', 'warning-add'
] as const);

export type TaskWorkflowOperation = typeof TASK_WORKFLOW_OPERATIONS[number];

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
  artifact?: string;
  family?: string;
  round?: number;
  expectedSha256?: string;
  expectedSemanticDigest?: string;
  fields?: Readonly<Record<string, string | number | boolean | null>>;
}>;

const WORKFLOW_FIELD_KEYS: Readonly<Record<TaskWorkflowOperation, readonly string[]>> = Object.freeze({
  'artifact-inspect': ['family', 'taskRef'],
  'artifact-finalize-local': ['artifact', 'family', 'taskRef'],
  'review-finalize-summary': ['artifact', 'dryRun', 'orchestrated', 'stage', 'taskRef'],
  event: ['agent', 'artifact', 'artifactSha256', 'event', 'implementationInput', 'manualValidation', 'major', 'minor', 'question', 'reasonCode', 'requestId', 'round', 'semanticDigest', 'summaryResult', 'taskRef', 'verdict'],
  'ledger-finding-response': ['evidence', 'id', 'intent', 'round', 'status', 'taskRef'],
  'ledger-finding-review': ['evidence', 'id', 'intent', 'needsImplementation', 'status', 'taskRef'],
  'ledger-finding-upsert': ['evidence', 'intent', 'ordinal', 'reviewArtifact', 'severity', 'stage', 'taskRef'],
  'decision-next-id': ['taskRef'],
  'decision-upsert': ['artifact', 'id', 'needsImplementation', 'stage', 'taskRef'],
  'invalidation-reconcile': ['dryRun', 'maxTargets', 'taskRef'],
  'warning-add': ['action', 'code', 'intent', 'message', 'severity', 'step', 'target', 'taskRef']
});

export function validateTaskWorkflowRequest(value: unknown): TaskWorkflowRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
  const request = value as Record<string, unknown>;
  const allowed = new Set(['version', 'id', 'taskId', 'generation', 'operation', 'artifact', 'family', 'round', 'expectedSha256', 'expectedSemanticDigest', 'fields', 'command', 'arguments']);
  if (Object.keys(request).some((key) => !allowed.has(key))) throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
  if (request.version !== 1 || typeof request.id !== 'string' || !request.id || typeof request.taskId !== 'string'
    || !/^TASK-\d{8}-\d{6}$/u.test(request.taskId) || typeof request.generation !== 'string' || !request.generation
    || typeof request.operation !== 'string' || !TASK_WORKFLOW_OPERATIONS.includes(request.operation as TaskWorkflowOperation)) {
    throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
  }
  for (const key of ['artifact', 'family'] as const) {
    if (request[key] !== undefined && (typeof request[key] !== 'string' || /[\\/\r\n]/u.test(request[key] as string))) {
      throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
    }
  }
  if (request.artifact !== undefined && (typeof request.artifact !== 'string' || !canonicalArtifactName(request.artifact))) throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
  if (request.round !== undefined && (!Number.isSafeInteger(request.round) || (request.round as number) < 1)) throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
  for (const key of ['expectedSha256', 'expectedSemanticDigest'] as const) {
    if (request[key] !== undefined && (typeof request[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(request[key] as string))) {
      throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
    }
  }
  if (request.fields !== undefined && (!request.fields || typeof request.fields !== 'object' || Array.isArray(request.fields))) throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
  if (request.fields !== undefined) {
    const fields = request.fields as Record<string, unknown>;
    const allowedFields = new Set(WORKFLOW_FIELD_KEYS[request.operation as TaskWorkflowOperation]);
    for (const [key, value] of Object.entries(fields)) {
      if (!allowedFields.has(key) || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null)) {
        throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
      }
      if (typeof value === 'string' && /[\r\n]/u.test(value)) throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
    }
    if (fields.taskRef !== undefined && fields.taskRef !== request.taskId) throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
  }
  return request as TaskWorkflowRequest;
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

type WorkflowCommand = 'task-artifact' | 'task-review' | 'task-event' | 'task-ledger' | 'task-invalidation' | 'task-warning';

function operationForCommand(command: WorkflowCommand | undefined, args: readonly string[]): TaskWorkflowOperation {
  if (command === 'task-artifact') {
    if (args[1] === 'inspect') return 'artifact-inspect';
    if (args[1] === 'finalize-local') return 'artifact-finalize-local';
  }
  if (command === 'task-review' && args[1] === 'finalize-summary') return 'review-finalize-summary';
  if (command === 'task-event' && args[1]) return 'event';
  if (command === 'task-invalidation' && args[1] === 'reconcile') return 'invalidation-reconcile';
  if (command === 'task-ledger') {
    return ({
      'finding-upsert': 'ledger-finding-upsert',
      'finding-respond': 'ledger-finding-response',
      'finding-review': 'ledger-finding-review',
      'decision-next-id': 'decision-next-id',
      'decision-upsert': 'decision-upsert'
    } as const)[args[1] as 'finding-upsert' | 'finding-respond' | 'finding-review' | 'decision-next-id' | 'decision-upsert'] ?? (() => { throw new Error('TASK_WORKFLOW_OPERATION_UNSUPPORTED'); })();
  }
  if (command === 'task-warning' && args[1] === 'add') return 'warning-add';
  throw new Error('TASK_WORKFLOW_OPERATION_UNSUPPORTED');
}

function flagName(value: string): string {
  return value.slice(2).replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function fieldsForCommand(command: WorkflowCommand, args: readonly string[]): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = { taskRef: args[0]! };
  if (command === 'task-artifact') fields.family = '';
  if (command === 'task-review') fields.stage = '';
  if (command === 'task-event') fields.event = args[1]!;
  if (command === 'task-ledger' || command === 'task-warning') fields.intent = args[1]!;
  for (let index = command === 'task-artifact' || command === 'task-review' || command === 'task-invalidation' || command === 'task-warning' || command === 'task-ledger' || command === 'task-event' ? 2 : 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--dry-run' || arg === '--orchestrated') {
      fields[arg === '--dry-run' ? 'dryRun' : 'orchestrated'] = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error('TASK_WORKFLOW_REQUEST_INVALID');
    fields[flagName(arg)] = value;
  }
  if (command === 'task-artifact') {
    fields.family = fields.family || '';
  }
  return fields;
}

export function workflowCommandForOperation(operation: TaskWorkflowOperation): WorkflowCommand {
  if (operation.startsWith('artifact-')) return 'task-artifact';
  if (operation === 'review-finalize-summary') return 'task-review';
  if (operation === 'event') return 'task-event';
  if (operation.startsWith('ledger-') || operation.startsWith('decision-')) return 'task-ledger';
  if (operation === 'invalidation-reconcile') return 'task-invalidation';
  return 'task-warning';
}

export function workflowArguments(request: TaskWorkflowRequest): readonly string[] {
  const fields = request.fields ?? {};
  const command = workflowCommandForOperation(request.operation);
  const operation = request.operation === 'artifact-inspect' ? 'inspect'
    : request.operation === 'artifact-finalize-local' ? 'finalize-local'
      : request.operation === 'review-finalize-summary' ? 'finalize-summary'
        : request.operation === 'invalidation-reconcile' ? 'reconcile'
            : request.operation === 'warning-add' ? 'add'
              : request.operation === 'ledger-finding-response' ? 'finding-respond'
                : request.operation.replace('ledger-', '').replace('decision-', 'decision-');
  const args = [request.taskId, operation];
  const excluded = new Set(['taskRef', 'event', 'intent']);
  if (request.operation === 'event') args[1] = String(fields.event ?? '');
  for (const [key, value] of Object.entries(fields)) {
    if (excluded.has(key) || key === 'event' || value === null || value === false) continue;
    const flag = `--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
    if (value === true) args.push(flag);
    else args.push(flag, String(value));
  }
  return args;
}

export function createTaskWorkflowRequest(
  command: WorkflowCommand | undefined,
  args: readonly string[],
  taskId: string,
  generation: string
): TaskWorkflowRequest {
  const operation = operationForCommand(command, args);
  const fields = fieldsForCommand(command!, args);
  const artifact = optionValue(args, '--artifact');
  const family = optionValue(args, '--family');
  const roundValue = optionValue(args, '--round');
  return validateTaskWorkflowRequest({
    version: 1,
    id: randomUUID(),
    taskId,
    generation,
    operation,
    ...(artifact ? { artifact } : {}),
    ...(family ? { family } : {}),
    ...(roundValue ? { round: Number(roundValue) } : {}),
    fields
  });
}

export function canonicalArtifactName(value: string): boolean {
  return /^(?:analysis|plan|code|review-analysis|review-plan|review-code)(?:-r[1-9]\d*)?\.md$/u.test(value)
    && path.basename(value) === value;
}

export function captureProjectionTopology(root: string): readonly ProjectionAncestorIdentity[] {
  const ancestors: ProjectionAncestorIdentity[] = [];
  let current = path.resolve(root);
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

function verifyProjectionTopology(manifest: TaskProjectionManifest): void {
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

export async function landProjectionArtifact(
  manifest: TaskProjectionManifest,
  input: Readonly<{
    artifact: string;
    expectedSha256?: string;
    validate?: (bytes: Buffer) => void | Promise<void>;
    semanticDigest?: (bytes: Buffer) => string;
    transform?: (bytes: Buffer) => Buffer | Promise<Buffer>;
  }>
): Promise<Readonly<{ artifact: string; bytes: number; sha256: string; semanticDigest: string | null }>> {
  const stable = await readProjectionArtifact(manifest, input);
  const target = path.join(manifest.authoritativeTaskDir, input.artifact);
  await writeAtomicFile(target, stable.bytes);
  return {
    artifact: input.artifact,
    bytes: stable.bytes.length,
    sha256: stable.sha256,
    semanticDigest: stable.semanticDigest
  };
}

export async function readProjectionArtifact(
  manifest: TaskProjectionManifest,
  input: Readonly<{
    artifact: string;
    expectedSha256?: string;
    validate?: (bytes: Buffer) => void | Promise<void>;
    semanticDigest?: (bytes: Buffer) => string;
    transform?: (bytes: Buffer) => Buffer | Promise<Buffer>;
  }>
): Promise<Readonly<{ artifact: string; bytes: Buffer; sha256: string; semanticDigest: string | null }>> {
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
  await input.validate?.(stable.bytes);
  const bytes = input.transform ? await input.transform(stable.bytes) : stable.bytes;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const semanticDigest = input.semanticDigest?.(bytes) ?? null;
  return { artifact: input.artifact, bytes, sha256, semanticDigest };
}

export function taskWorkflowAuditFields(request: TaskWorkflowRequest, result: Readonly<{ bytes?: number; sha256?: string; semanticDigest?: string | null; outcome: string }>): Readonly<Record<string, string | number | null>> {
  return {
    requestId: request.id,
    taskId: request.taskId,
    operation: request.operation,
    family: request.family ?? null,
    artifact: request.artifact ?? null,
    bytes: result.bytes ?? 0,
    sha256: result.sha256 ?? null,
    semanticDigest: result.semanticDigest ?? null,
    outcome: result.outcome,
    authorityKind: 'sandbox-broker'
  };
}

export function digestProjectionManifest(manifest: TaskProjectionManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex');
}
