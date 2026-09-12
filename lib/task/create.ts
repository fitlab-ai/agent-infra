import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isValidAgentInfraVersion, VERSION } from '../version.ts';
import { loadShortIdByTaskId, mutateShortIdRegistry } from './short-id.ts';
import { DEFAULT_TRANSITION_LOCK_ROOT, TaskExecutionLockError, withTaskExecutionLock } from './task-execution-lock.ts';
import { readDeliveryDefaults, validateBaseRef, validateRemote } from './delivery-target.ts';
import { buildUnboundFact, encodePrDeliveryFact } from './pr-delivery-fact.ts';
import { CANDIDATE_COLUMNS, CONSTRAINT_COLUMNS, parseTaskQualification } from './qualification-audit.ts';

const AGENTS = ['claude', 'codex', 'antigravity', 'opencode', 'cursor'] as const;
const TYPES = ['feature', 'bugfix', 'refactor', 'docs', 'chore'] as const;
const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'] as const;
const EFFORTS = ['High', 'Medium', 'Low'] as const;
const TASK_INPUT_KEYS = [
  'sources', 'facts', 'constraints', 'decisions', 'alternatives',
  'acceptanceCriteria', 'openQuestions'
] as const;

type TaskAgent = typeof AGENTS[number];
type TaskType = typeof TYPES[number];
type TaskPriority = typeof PRIORITIES[number];
type TaskEffort = typeof EFFORTS[number];

type TaskCreateCandidateV1 = Readonly<{
  version: 1;
  idempotencyKey: string;
  agent: TaskAgent;
  title: string;
  type: TaskType;
  branchSlug: string;
  priority: TaskPriority;
  effort: TaskEffort;
  description: string;
  deliveryRemote?: string;
  deliveryBaseRef?: string;
  taskInput: Readonly<Record<typeof TASK_INPUT_KEYS[number], readonly string[]>>;
}>;

type LocalTaskCreateResult = Readonly<{
  status: 'applied' | 'no-op';
  changed: boolean;
  task: { id: string; shortId: string };
}>;

type LocalTaskCreateOptions = Readonly<{
  repoRoot: string;
  now?: () => Date;
  agentInfraVersion?: string;
}>;

function payloadError(message: string): never {
  throw new Error(`TASK_CREATE_PAYLOAD_INVALID: ${message}`);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string, optional: readonly string[] = []): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const allowed = new Set([...expected, ...optional]);
  if (actual.some((key) => !allowed.has(key))) {
    payloadError(`${label} has unknown or missing fields`);
  }
  if (expected.some((key) => !actual.includes(key))) payloadError(`${label} has unknown or missing fields`);
}

function cleanString(value: unknown, label: string, maxBytes: number, oneLine = false): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    payloadError(`${label} must be a non-empty string within ${maxBytes} bytes`);
  }
  if (/\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || (oneLine && /[\r\n]/u.test(value))) {
    payloadError(`${label} contains unsupported control characters`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) payloadError(`${label} is invalid`);
  return value as T;
}

function validateTaskCreateCandidate(value: unknown): TaskCreateCandidateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) payloadError('candidate must be an object');
  const candidate = value as Record<string, unknown>;
  exactKeys(candidate, [
    'version', 'idempotencyKey', 'agent', 'title', 'type', 'branchSlug',
    'priority', 'effort', 'description', 'taskInput'
  ], 'candidate', ['deliveryRemote', 'deliveryBaseRef']);
  if (candidate.version !== 1) payloadError('version must be 1');
  const idempotencyKey = cleanString(candidate.idempotencyKey, 'idempotencyKey', 64, true);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
    payloadError('idempotencyKey must be a UUID v4');
  }
  const title = cleanString(candidate.title, 'title', 400, true);
  if ([...title].length > 100) payloadError('title exceeds 100 Unicode code points');
  const branchSlug = cleanString(candidate.branchSlug, 'branchSlug', 64, true);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(branchSlug) || branchSlug.length < 3) {
    payloadError('branchSlug must be lowercase ASCII kebab-case with length 3-64');
  }
  const description = cleanString(candidate.description, 'description', 8 * 1024);
  const deliveryRemote = candidate.deliveryRemote === undefined
    ? undefined
    : cleanString(candidate.deliveryRemote, 'deliveryRemote', 200, true);
  const deliveryBaseRef = candidate.deliveryBaseRef === undefined
    ? undefined
    : cleanString(candidate.deliveryBaseRef, 'deliveryBaseRef', 200, true);
  if (deliveryRemote !== undefined && !validateRemote(deliveryRemote)) payloadError('deliveryRemote is invalid');
  if (deliveryBaseRef !== undefined && !validateBaseRef(deliveryBaseRef)) payloadError('deliveryBaseRef is invalid');
  if (!candidate.taskInput || typeof candidate.taskInput !== 'object' || Array.isArray(candidate.taskInput)) {
    payloadError('taskInput must be an object');
  }
  const rawInput = candidate.taskInput as Record<string, unknown>;
  exactKeys(rawInput, TASK_INPUT_KEYS, 'taskInput');
  const taskInput = Object.fromEntries(TASK_INPUT_KEYS.map((key) => {
    const list = rawInput[key];
    if (!Array.isArray(list) || list.length > 50) payloadError(`taskInput.${key} must contain at most 50 items`);
    return [key, list.map((item, index) => cleanString(item, `taskInput.${key}[${index}]`, 2 * 1024, true))];
  })) as unknown as TaskCreateCandidateV1['taskInput'];
  return {
    version: 1,
    idempotencyKey,
    agent: enumValue(candidate.agent, AGENTS, 'agent'),
    title,
    type: enumValue(candidate.type, TYPES, 'type'),
    branchSlug,
    priority: enumValue(candidate.priority, PRIORITIES, 'priority'),
    effort: enumValue(candidate.effort, EFFORTS, 'effort'),
    description,
    ...(deliveryRemote === undefined ? {} : { deliveryRemote }),
    ...(deliveryBaseRef === undefined ? {} : { deliveryBaseRef }),
    taskInput
  };
}

function canonicalTaskCreateCandidate(candidate: TaskCreateCandidateV1): string {
  const valid = validateTaskCreateCandidate(candidate);
  return JSON.stringify({
    version: valid.version,
    idempotencyKey: valid.idempotencyKey,
    agent: valid.agent,
    title: valid.title,
    type: valid.type,
    branchSlug: valid.branchSlug,
    priority: valid.priority,
    effort: valid.effort,
    description: valid.description,
    deliveryRemote: valid.deliveryRemote ?? null,
    deliveryBaseRef: valid.deliveryBaseRef ?? null,
    taskInput: Object.fromEntries(TASK_INPUT_KEYS.map((key) => [key, valid.taskInput[key]]))
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offset = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

function taskIdFor(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `TASK-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function markdownBlock(value: string): string {
  return value.split(/\r?\n/).map((line) => /^(?:#{1,6}\s|```)/.test(line) ? `\\${line}` : line).join('\n');
}

function renderList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function tableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
}

function renderTable(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(tableCell).join(' | ')} |`)
  ].join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function candidateIdFor(index: number): string {
  let value = index + 1;
  let id = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    id = `${String.fromCharCode(65 + remainder)}${id}`;
    value = Math.floor((value - 1) / 26);
  }
  return id;
}

function appendCanonicalRows(content: string, heading: string, columns: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return content;
  const table = renderTable(columns, rows);
  const [header, separator, ...rowLines] = table.split('\n');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const headingPattern = new RegExp(`^###\\s+${escapeRegExp(heading)}\\s*$`);
  const sectionStart = lines.findIndex((line) => headingPattern.test(line));
  if (sectionStart < 0) throw new Error(`TASK_CREATE_QUALIFICATION_INVALID: section '${heading}' is missing`);
  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^#{2,3}\s+/.test(lines[index]!)) {
      sectionEnd = index;
      break;
    }
  }
  const matches: number[] = [];
  for (let index = sectionStart + 1; index + 1 < sectionEnd; index += 1) {
    if (lines[index]!.trim() === header && lines[index + 1]!.trim() === separator) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(`TASK_CREATE_QUALIFICATION_INVALID: section '${heading}' must contain exactly one canonical qualification table`);
  }
  lines.splice(matches[0]! + 2, 0, ...rowLines);
  return lines.join(eol);
}

function validateRenderedQualification(content: string, candidate: TaskCreateCandidateV1): void {
  const parsed = parseTaskQualification(content);
  if (!parsed.ok) {
    throw new Error(`TASK_CREATE_QUALIFICATION_INVALID: ${parsed.code}: ${parsed.message}`);
  }
  if (!parsed.qualification.present) {
    throw new Error('TASK_CREATE_QUALIFICATION_INVALID: rendered task qualification contract is missing');
  }
  const expectedConstraintIds = candidate.taskInput.constraints.map((_, index) => `C-${index + 1}`);
  const expectedCandidateIds = candidate.taskInput.alternatives.map((_, index) => candidateIdFor(index));
  const actualConstraintIds = parsed.qualification.constraints.map((row) => row.constraintId);
  const actualCandidateIds = parsed.qualification.candidates.map((row) => row.candidateId);
  if (JSON.stringify(actualConstraintIds) !== JSON.stringify(expectedConstraintIds)
    || JSON.stringify(actualCandidateIds) !== JSON.stringify(expectedCandidateIds)) {
    throw new Error('TASK_CREATE_QUALIFICATION_INVALID: rendered task qualification rows do not match task input');
  }
}

function replaceEmptySubsection(content: string, heading: string, items: readonly string[]): string {
  if (items.length === 0) return content;
  return content.replace(`${heading}\n`, `${heading}\n\n${renderList(items)}\n`);
}

function renderTask(params: Readonly<{
  template: string;
  candidate: TaskCreateCandidateV1;
  taskId: string;
  project: string;
  delivery: { remote: string; baseRef: string };
  timestamp: string;
  agentInfraVersion: string;
  keyDigest: string;
  candidateDigest: string;
}>): string {
  const { candidate } = params;
  const workflow = candidate.type === 'bugfix' ? 'bug-fix' : candidate.type === 'refactor' ? 'refactoring' : 'feature-development';
  const branch = `${params.project}-${candidate.type}-${candidate.branchSlug}`;
  const frontmatter = [
    '---',
    `id: ${params.taskId}`,
    `type: ${candidate.type}`,
    `branch: ${branch}`,
    `workflow: ${workflow}`,
    'status: active',
    `created_at: ${params.timestamp}`,
    `updated_at: ${params.timestamp}`,
    `agent_infra_version: ${params.agentInfraVersion}`,
    `priority: ${candidate.priority}`,
    `effort: ${candidate.effort}`,
    'start_date:',
    'target_date:',
    'current_step: requirement-analysis',
    `assigned_to: ${candidate.agent}`,
    `pr_delivery_fact: ${JSON.stringify(encodePrDeliveryFact(buildUnboundFact()))}`,
    `delivery_remote: ${candidate.deliveryRemote ?? params.delivery.remote}`,
    `delivery_base_ref: ${candidate.deliveryBaseRef ?? params.delivery.baseRef}`,
    'checkpoint_commit:',
    'delivery_remote_head:',
    `task_create_key_digest: ${params.keyDigest}`,
    `task_create_candidate_digest: ${params.candidateDigest}`,
    '---'
  ].join('\n');
  let content = params.template.replace(/^---\n[\s\S]*?\n---/, frontmatter);
  content = content.replace('# 任务：[标题]', `# 任务：${candidate.title}`);
  content = content.replace('[清晰简洁地描述任务。]', markdownBlock(candidate.description));
  const sections: Array<[string, keyof TaskCreateCandidateV1['taskInput']]> = [
    ['### 来源', 'sources'], ['### 已确认事实与证据', 'facts'], ['### 约束', 'constraints'],
    ['### 已确认决策', 'decisions'], ['### 候选与否决方案', 'alternatives'],
    ['### 验收标准', 'acceptanceCriteria'], ['### 未决事项', 'openQuestions']
  ];
  for (const [heading, key] of sections) content = replaceEmptySubsection(content, heading, candidate.taskInput[key]);
  const constraintIds = candidate.taskInput.constraints.map((_, index) => `C-${index + 1}`);
  content = appendCanonicalRows(content, '约束', CONSTRAINT_COLUMNS, candidate.taskInput.constraints.map((statement, index) => [
    constraintIds[index]!, statement, 'assumption', 'create-task', 'taskInput', 'create-task input', '', ''
  ]));
  content = appendCanonicalRows(content, '候选与否决方案', CANDIDATE_COLUMNS, candidate.taskInput.alternatives.map((statement, index) => [
    candidateIdFor(index), statement, 'pending', constraintIds.join(','), 'requires qualification', 'create-task input'
  ]));
  content = content.replace('- **关联 Issue**：#XXX', '- **关联 Issue**：N/A');
  content = content.replace('- **关联 PR**：#XXX', '- **关联 PR**：N/A');
  content = content.replace('- **分支**：`feature/xxx`', `- **分支**：\`${branch}\``);
  const log = [
    `- ${params.timestamp} — **Create Task [started]** by ${candidate.agent} — started`,
    `- ${params.timestamp} — **Create Task** by ${candidate.agent} — Task created from structured candidate`
  ].join('\n');
  content = content.replace('\n## 完成检查清单', `\n${log}\n\n## 完成检查清单`);
  return `${content.trimEnd()}\n`;
}

function readProject(repoRoot: string): { project: string; delivery: { remote: string; baseRef: string } } {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, '.agents', '.airc.json'), 'utf8')) as { project?: unknown; delivery?: { remote?: unknown; baseRef?: unknown } };
  if (typeof config.project !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.project)) {
    throw new Error('TASK_CREATE_CONFIG_INVALID: project is missing or invalid');
  }
  const delivery = readDeliveryDefaults(repoRoot);
  if (!delivery.ok) throw new Error(`TASK_CREATE_CONFIG_INVALID: ${delivery.message}`);
  return { project: config.project, delivery: delivery.value };
}

function assertRealDirectory(directory: string, code: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(code);
}

function ensureRealDirectory(directory: string, code: string): void {
  if (fs.existsSync(directory)) {
    assertRealDirectory(directory, code);
    return;
  }
  fs.mkdirSync(directory, { mode: 0o700 });
}

function withCreateLock<T>(repoRoot: string, workspaceRoot: string, operation: () => T): T {
  const lockRoot = path.join(workspaceRoot, '.task-create.lock');
  fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  assertRealDirectory(lockRoot, 'TASK_CREATE_LOCK_FAILED');
  let callbackError: unknown;
  try {
    return withTaskExecutionLock(repoRoot, 'task-create', 'task-create', () => {
      try { return operation(); }
      catch (error) { callbackError = error; throw error; }
    }, { lockRoot, transitionLockRoot: DEFAULT_TRANSITION_LOCK_ROOT });
  } catch (error) {
    if (callbackError !== undefined) throw callbackError;
    if (error instanceof TaskExecutionLockError && error.code === 'ORCHESTRATION_LOCK_BUSY') {
      throw new Error('TASK_CREATE_LOCK_TIMEOUT');
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`TASK_CREATE_LOCK_FAILED: ${message}`);
  }
}

function writeReceipt(receiptPath: string, value: unknown): void {
  const temporary = `${receiptPath}.tmp.${process.pid}.${randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  try { fs.renameSync(temporary, receiptPath); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function recoverPublishedTask(activeRoot: string, repoRoot: string, keyDigest: string, candidateDigest: string): { taskId: string; shortId: string } | null {
  for (const name of fs.readdirSync(activeRoot)) {
    if (!/^TASK-\d{8}-\d{6}$/.test(name)) continue;
    const taskDir = path.join(activeRoot, name);
    const stat = fs.lstatSync(taskDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const taskMd = path.join(taskDir, 'task.md');
    if (!fs.existsSync(taskMd)) continue;
    const taskStat = fs.lstatSync(taskMd);
    if (!taskStat.isFile() || taskStat.isSymbolicLink()) continue;
    const content = fs.readFileSync(taskMd, 'utf8');
    if (!content.includes(`task_create_key_digest: ${keyDigest}`)) continue;
    if (!content.includes(`task_create_candidate_digest: ${candidateDigest}`)) {
      throw new Error('TASK_CREATE_IDEMPOTENCY_CONFLICT');
    }
    const shortId = loadShortIdByTaskId(repoRoot).get(name)
      ?? mutateShortIdRegistry(repoRoot, name, 'alloc').shortId;
    if (!shortId) throw new Error('TASK_CREATE_RECEIPT_INVALID');
    return { taskId: name, shortId };
  }
  return null;
}

function createLocalTask(value: unknown, options: LocalTaskCreateOptions): LocalTaskCreateResult {
  const candidate = validateTaskCreateCandidate(value);
  const agentInfraVersion = options.agentInfraVersion ?? VERSION;
  if (!isValidAgentInfraVersion(agentInfraVersion)) {
    throw new Error('TASK_CREATE_VERSION_INVALID: agentInfraVersion must be a valid v-prefixed semver');
  }
  const repoRoot = fs.realpathSync.native(options.repoRoot);
  const workspaceRoot = path.join(repoRoot, '.agents', 'workspace');
  const activeRoot = path.join(workspaceRoot, 'active');
  ensureRealDirectory(path.join(repoRoot, '.agents'), 'TASK_CREATE_WORKSPACE_INVALID');
  ensureRealDirectory(workspaceRoot, 'TASK_CREATE_WORKSPACE_INVALID');
  ensureRealDirectory(activeRoot, 'TASK_CREATE_WORKSPACE_INVALID');
  const projectConfig = readProject(repoRoot);
  const canonical = canonicalTaskCreateCandidate(candidate);
  const candidateDigest = sha256(canonical);
  const keyDigest = sha256(candidate.idempotencyKey);
  const receipts = path.join(workspaceRoot, '.task-create');

  return withCreateLock(repoRoot, workspaceRoot, () => {
    if (fs.existsSync(receipts)) assertRealDirectory(receipts, 'TASK_CREATE_RECEIPT_INVALID');
    const receiptPath = path.join(receipts, `${keyDigest}.json`);
    if (fs.existsSync(receiptPath)) {
      const stat = fs.lstatSync(receiptPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('TASK_CREATE_RECEIPT_INVALID');
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as { candidateDigest?: string; taskId?: string; shortId?: string };
      if (receipt.candidateDigest !== candidateDigest) throw new Error('TASK_CREATE_IDEMPOTENCY_CONFLICT');
      if (!receipt.taskId || !receipt.shortId || !fs.existsSync(path.join(activeRoot, receipt.taskId, 'task.md'))) {
        throw new Error('TASK_CREATE_RECEIPT_INVALID');
      }
      return { status: 'no-op', changed: false, task: { id: receipt.taskId, shortId: receipt.shortId } };
    }

    const recovered = recoverPublishedTask(activeRoot, repoRoot, keyDigest, candidateDigest);
    if (recovered) {
      ensureRealDirectory(receipts, 'TASK_CREATE_RECEIPT_INVALID');
      writeReceipt(receiptPath, {
        version: 1, candidateDigest, taskId: recovered.taskId, shortId: recovered.shortId, status: 'recovered'
      });
      return { status: 'no-op', changed: false, task: { id: recovered.taskId, shortId: recovered.shortId } };
    }

    const base = options.now?.() ?? new Date();
    let taskDate = new Date(base.getTime());
    let taskId = taskIdFor(taskDate);
    while (fs.existsSync(path.join(activeRoot, taskId))) {
      taskDate = new Date(taskDate.getTime() + 1_000);
      taskId = taskIdFor(taskDate);
    }
    const timestamp = formatTimestamp(base);
    const templatePath = path.join(repoRoot, '.agents', 'templates', 'task.md');
    const templateStat = fs.lstatSync(templatePath);
    if (!templateStat.isFile() || templateStat.isSymbolicLink()) throw new Error('TASK_CREATE_TEMPLATE_INVALID');
    const rendered = renderTask({
      template: fs.readFileSync(templatePath, 'utf8'), candidate, taskId, project: projectConfig.project, delivery: projectConfig.delivery, timestamp,
      agentInfraVersion, keyDigest, candidateDigest
    });
    validateRenderedQualification(rendered, candidate);
    ensureRealDirectory(receipts, 'TASK_CREATE_RECEIPT_INVALID');
    const temporary = path.join(workspaceRoot, `.task-create.tmp.${process.pid}.${randomUUID()}`);
    fs.mkdirSync(temporary, { mode: 0o700 });
    fs.writeFileSync(path.join(temporary, 'task.md'), rendered, { flag: 'wx', mode: 0o600 });
    const destination = path.join(activeRoot, taskId);
    fs.renameSync(temporary, destination);
    let shortId: string;
    try {
      const allocated = mutateShortIdRegistry(repoRoot, taskId, 'alloc');
      if (!allocated.shortId) throw new Error('TASK_CREATE_SHORT_ID_FAILED');
      shortId = allocated.shortId;
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
    try {
      writeReceipt(receiptPath, { version: 1, candidateDigest, taskId, shortId, status: 'created' });
    } catch (error) {
      mutateShortIdRegistry(repoRoot, taskId, 'release');
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    }
    return { status: 'applied', changed: true, task: { id: taskId, shortId } };
  });
}

export {
  canonicalTaskCreateCandidate,
  createLocalTask,
  validateTaskCreateCandidate
};
export type {
  LocalTaskCreateOptions,
  LocalTaskCreateResult,
  TaskCreateCandidateV1
};
