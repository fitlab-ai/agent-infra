import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { locateActivityLog } from './activity-log.ts';
import { applyPrReviewActivityIntent } from './activity-intent.ts';
import { applyHumanDecision } from './decision-intents.ts';
import { applyTaskEvent } from './events.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import { applyTaskLifecycle, lifecycleProducerCatalog } from './lifecycle.ts';
import type { TaskLifecycleIntent, TaskLifecycleRequest } from './lifecycle.ts';
import { guardFailureId, guardProducerCatalog } from './guard-override.ts';
import type { GuardProducer, ManualOverrideCapability } from './guard-override.ts';
import { inspectLifecycleExecution } from './lifecycle-execution.ts';
import { applyLedgerIntent } from './ledger-intents.ts';
import { bindPlatformIssue } from '../platform/issues.ts';
import { bindPlatformPullRequest } from '../platform/pull-requests.ts';
import type { GitHubClient } from '../platform/github-client.ts';
import { finalizeReviewSummary } from './review-finalization.ts';
import { resolveTaskRef } from './resolve-ref.ts';
import { DocumentMutationError, parseTable } from './sections.ts';
import { applyWorkflowWarningIntent } from './workflow-warning-intents.ts';
import { verifyTaskEvent } from './verification.ts';
import { verifyInProcess } from './verification-engine.ts';
import { canonicalTimestamp, writeTask } from './write.ts';
import type { TaskFileSystem, TaskWriteMetadata, TaskWriteResult } from './write.ts';
import { readPrDeliveryFact } from './pr-delivery-fact.ts';

type Eligibility = 'eligible' | 'repair-only' | 'runtime-recovery-only' | 'never-overridable';
type OutcomeEffect = 'apply-target' | 'retry-same-intent' | 'record-only' | 'no-write';
type OutcomeResult = 'human-approved' | 'safe-closed' | 'recovery-required' | 'preserve-failure';

type FailureIdentity = Readonly<{
  id: string;
  producerId: string;
  guardId: string;
  code: string;
}>;

type OutcomeContext = Readonly<{
  id: string;
  facts: readonly string[];
}>;

type OutcomeRule = Readonly<{
  target: string;
  contextId: string;
  effect: OutcomeEffect;
  result: OutcomeResult;
  residual: string;
}>;

type OutcomeFallback = Readonly<{
  effect: 'no-write' | 'record-only';
  result: 'recovery-required' | 'preserve-failure';
  residual: string;
}>;

type FailurePolicy = FailureIdentity & Readonly<{
  eligibility: Eligibility;
  capability: string;
  targets: readonly string[];
  contexts: readonly OutcomeContext[];
  targetContexts: Readonly<Record<string, readonly string[]>>;
  outcomes: readonly OutcomeRule[];
  fallback: OutcomeFallback;
  probeId: string;
}>;

type Outcome = Readonly<{
  effect: OutcomeEffect;
  result: OutcomeResult;
  residual: string;
  policyId: string;
  target: string;
  contextId: string;
}>;

type HumanOverrideIdentity = Readonly<{
  source: 'local-declared';
  operator: string;
  verified: false;
}>;

type HumanOverrideOptions = Readonly<{
  repoRoot?: string;
  now?: () => string;
  randomId?: () => string;
  metadataProvider?: () => TaskWriteMetadata;
  randomSuffix?: () => string;
  taskFileSystem?: Partial<TaskFileSystem>;
  probeIntent?: TaskLifecycleIntent;
  probeOperator?: string;
  probeReason?: string;
  probeAlertNumber?: number;
  probeIssueNumber?: number;
  probePullRequestNumber?: number;
  probeStagingDir?: string;
  platformClient?: GitHubClient;
  effectExecutor?: (capability: ManualOverrideCapability) => OverrideError | null;
}>;

type FailureSnapshot = Readonly<{
  schema: '1';
  taskId: string;
  failureId: string;
  producerId: string;
  code: string;
  target: string;
  state: string;
  digest: string;
  observedFacts: readonly string[];
  message: string;
  capturedAt: string;
  source: 'producer-result';
}>;

type HumanOverrideRequest = Readonly<{
  taskRef: string;
  failureId: string;
  target: string;
  operator: string;
  reason: string;
  scope: string;
  expiresAt: string;
  intent?: TaskLifecycleIntent;
  alertNumber?: number;
  issueNumber?: number;
  pullRequestNumber?: number;
  stagingDir?: string;
  failureDigest?: string;
  failureSnapshot?: FailureSnapshot;
  identitySource?: string;
}>;

type ConsumeHumanOverrideRequest = Readonly<{
  taskRef: string;
  ticketId: string;
  failureId: string;
  target: string;
  scope: string;
  intent?: TaskLifecycleIntent;
  alertNumber?: number;
  issueNumber?: number;
  pullRequestNumber?: number;
  stagingDir?: string;
  failureDigest?: string;
  observedFacts?: readonly string[];
  failureSnapshot?: FailureSnapshot;
}>;

type OverrideError = Readonly<{ code: string; message: string }>;

type HumanOverrideIssueResult =
  | Readonly<{
      status: 'applied' | 'no-op';
      changed: boolean;
      ticketId: string;
      taskId: string;
      identity: HumanOverrideIdentity;
      error: null;
    }>
  | Readonly<{
      status: 'failed';
      changed: false;
      ticketId: string | null;
      taskId: string | null;
      identity: HumanOverrideIdentity | null;
      error: OverrideError;
    }>;

type HumanOverrideConsumeResult =
  | Readonly<{
      status: 'applied' | 'no-op';
      changed: boolean;
      ticketId: string;
      taskId: string;
      outcome: Outcome;
      manualOverride?: ManualOverrideCapability;
      error: null;
    }>
  | Readonly<{
      status: 'failed';
      changed: false;
      ticketId: string | null;
      taskId: string | null;
      outcome: Outcome | null;
      error: OverrideError;
    }>;

const LIFECYCLE_PRODUCER = 'lifecycle.apply';
const HUMAN_OVERRIDE_SECTION_ALIASES = ['人工豁免账本', 'Human Override Ledger'] as const;
const HUMAN_OVERRIDE_COLUMNS = [
  'id', 'schema', 'failure_id', 'producer_id', 'code', 'target', 'operator',
  'identity_source', 'verified', 'reason', 'scope', 'intent', 'failure_message',
  'failure_digest', 'context_id', 'effect', 'source_state', 'issued_at', 'expires_at', 'status',
  'result', 'consumed_at', 'residual', 'alert_number', 'issue_number', 'pull_request_number', 'staging_dir'
] as const;
const LEGACY_HUMAN_OVERRIDE_COLUMNS = HUMAN_OVERRIDE_COLUMNS.filter((column) => column !== 'pull_request_number');
const PULL_REQUEST_NUMBER_COLUMN = 'pull_request_number';

const SHORT_ID_CONFIRMED = 'identity-confirmed-and-safe-close-proven';
const SHORT_ID_UNCONFIRMED = 'identity-unconfirmed';
const REGISTRY_RECOVERABLE = 'registry-recoverable';

function failureId(producerId: string, code: string): string {
  if (!singleLine(producerId) || !singleLine(code) || producerId.includes(':') || code.includes(':')) {
    throw new Error('failure identity producer and code must be non-empty and colon-free');
  }
  return `${producerId}:${code}`;
}

function identity(producerId: string, code: string, guardId = code): FailureIdentity {
  return { id: failureId(producerId, code), producerId, guardId, code };
}

function context(id: string, ...facts: string[]): OutcomeContext {
  return { id, facts };
}

function makeSimplePolicy(code: string, eligibility: Eligibility, target: string, result: OutcomeResult): FailurePolicy {
  const id = failureId(LIFECYCLE_PRODUCER, code);
  const contextId = 'identity-confirmed';
  const effect: OutcomeEffect = result === 'preserve-failure' ? 'record-only' : 'apply-target';
  return {
    ...identity(LIFECYCLE_PRODUCER, code, 'G-03'),
    eligibility,
    capability: eligibility === 'never-overridable' ? 'audit-only' : 'local-task-repair',
    targets: [target],
    contexts: [context(contextId, contextId)],
    targetContexts: { [target]: [contextId] },
    outcomes: [{
      target,
      contextId,
      effect,
      result,
      residual: result === 'preserve-failure' ? 'original failure remains authoritative' : 'local operator action was applied to the task'
    }],
    fallback: {
      effect: 'no-write',
      result: result === 'preserve-failure' ? 'preserve-failure' : 'recovery-required',
      residual: 'outcome context was not confirmed; no target state was written'
    },
    probeId: `probe.${code.toLowerCase()}`
  };
}

function simplePolicy(code: string): FailurePolicy {
  if (code === 'LIFECYCLE_SOURCE_INVALID') return makeSimplePolicy(code, 'eligible', 'continue-local', 'human-approved');
  if (code === 'LIFECYCLE_LOG_MISSING' || code === 'LIFECYCLE_METADATA_FAILED' || code === 'LIFECYCLE_DOCUMENT_INVALID') {
    return makeSimplePolicy(code, 'repair-only', 'repair-task', 'recovery-required');
  }
  if (code === 'LIFECYCLE_IDENTITY_CONFLICT' || code === 'LIFECYCLE_IDENTITY_INVALID' || code === 'LIFECYCLE_PAYLOAD_INVALID' || code === 'LIFECYCLE_STAGING_IDENTITY_INVALID' || code === 'LIFECYCLE_STAGING_INVALID') {
    return makeSimplePolicy(code, 'never-overridable', 'record-only', 'preserve-failure');
  }
  return makeSimplePolicy(code, 'runtime-recovery-only', 'retry-same-intent', 'recovery-required');
}

function genericGuardPolicy(producer: GuardProducer): FailurePolicy {
  const preserve = producer.guardId === 'G-01' || producer.guardId === 'G-09' || producer.guardId === 'G-10';
  const contextId = 'guard-observed';
  const result: OutcomeResult = preserve ? 'preserve-failure' : 'human-approved';
  const effect: OutcomeEffect = preserve ? 'record-only' : 'apply-target';
  return {
    ...identity(producer.producerId, producer.code, producer.guardId),
    eligibility: preserve ? 'never-overridable' : 'eligible',
    capability: preserve ? 'audit-only' : `local-${producer.guardId.toLowerCase()}-gate`,
    targets: ['continue-local'],
    contexts: [context(contextId, contextId)],
    targetContexts: { 'continue-local': [contextId] },
    outcomes: [{
      target: 'continue-local',
      contextId,
      effect,
      result,
      residual: preserve ? 'external or identity evidence remains authoritative' : `${producer.guardId} local guard was explicitly overridden`
    }],
    fallback: {
      effect: 'record-only',
      result: 'preserve-failure',
      residual: 'guard facts were not confirmed; the original failure remains authoritative'
    },
    probeId: `probe.${producer.producerId}.${producer.code.toLowerCase()}`
  };
}

const shortIdPolicy: FailurePolicy = {
  ...identity(LIFECYCLE_PRODUCER, 'SHORT_ID_CAPACITY_EXCEEDED', 'G-03'),
  eligibility: 'repair-only',
  capability: 'safe-close-or-registry-recovery',
  targets: ['safe-close', 'recover-registry'],
  contexts: [
    context(SHORT_ID_CONFIRMED, SHORT_ID_CONFIRMED),
    context(SHORT_ID_UNCONFIRMED, SHORT_ID_UNCONFIRMED),
    context(REGISTRY_RECOVERABLE, REGISTRY_RECOVERABLE)
  ],
  targetContexts: {
    'safe-close': [SHORT_ID_CONFIRMED, SHORT_ID_UNCONFIRMED],
    'recover-registry': [REGISTRY_RECOVERABLE]
  },
  outcomes: [
    {
      target: 'safe-close',
      contextId: SHORT_ID_CONFIRMED,
      effect: 'apply-target',
      result: 'safe-closed',
      residual: 'task was atomically safe-closed without entering active or expanding short-id capacity'
    },
    {
      target: 'safe-close',
      contextId: SHORT_ID_UNCONFIRMED,
      effect: 'no-write',
      result: 'recovery-required',
      residual: 'task identity could not be confirmed; no terminal state was written'
    },
    {
      target: 'recover-registry',
      contextId: REGISTRY_RECOVERABLE,
      effect: 'retry-same-intent',
      result: 'recovery-required',
      residual: 'registry recovery must complete before a new diagnosis and ticket are issued'
    }
  ],
  fallback: {
    effect: 'no-write',
    result: 'recovery-required',
    residual: 'short-id failure facts did not match a registered safe outcome context; original failure remains authoritative'
  },
  probeId: 'probe.short-id-capacity'
};

const HUMAN_OVERRIDE_FAILURE_REGISTRY: readonly FailurePolicy[] = [
  shortIdPolicy,
  ...lifecycleProducerCatalog
    .filter(({ code }) => code !== 'SHORT_ID_CAPACITY_EXCEEDED')
    .map(({ code }) => simplePolicy(code)),
  ...guardProducerCatalog.map((producer) => genericGuardPolicy(producer))
];

const stableFailureCatalog = [
  ...lifecycleProducerCatalog,
  ...guardProducerCatalog
].map(({ producerId, guardId, code }) => ({
  id: guardFailureId(producerId, code),
  producerId,
  guardId,
  code
}));

function singleLine(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value);
}

function validatePolicy(policy: FailurePolicy): void {
  if (!singleLine(policy.id) || !singleLine(policy.producerId) || !singleLine(policy.guardId) || !singleLine(policy.code)) {
    throw new Error('failure policy identity is invalid');
  }
  if (policy.id !== failureId(policy.producerId, policy.code)) throw new Error(`policy ${policy.id} has an invalid identity`);
  if (!Array.isArray(policy.targets) || new Set(policy.targets).size !== policy.targets.length || policy.targets.length === 0) {
    throw new Error(`policy ${policy.id} targets are invalid`);
  }
  if (!Array.isArray(policy.contexts) || policy.contexts.length === 0) throw new Error(`policy ${policy.id} contexts are missing`);
  const contexts = new Map<string, OutcomeContext>();
  for (const item of policy.contexts) {
    if (!singleLine(item.id) || contexts.has(item.id) || item.facts.length === 0 || new Set(item.facts).size !== item.facts.length) {
      throw new Error(`policy ${policy.id} contains invalid or duplicate contexts`);
    }
    contexts.set(item.id, item);
  }
  const contextFactsByTarget = new Map<string, Set<string>>();
  for (const target of policy.targets) {
    const facts = contextFactsByTarget.get(target) ?? new Set<string>();
    for (const contextId of policy.targetContexts[target] ?? []) {
      const item = contexts.get(contextId);
      if (!item) continue;
      const key = item.facts.slice().sort().join('\0');
      if (facts.has(key)) throw new Error(`policy ${policy.id} has overlapping context facts for target ${target}`);
      facts.add(key);
    }
    contextFactsByTarget.set(target, facts);
  }
  const outcomes = new Set<string>();
  for (const target of policy.targets) {
    const contextIds = policy.targetContexts[target];
    if (!contextIds || contextIds.length === 0) throw new Error(`policy ${policy.id} target ${target} has no contexts`);
    for (const contextId of contextIds) {
      if (!contexts.has(contextId)) throw new Error(`policy ${policy.id} references unknown context ${contextId}`);
      const key = `${target}\0${contextId}`;
      if (outcomes.has(key)) throw new Error(`policy ${policy.id} has overlapping outcome ${key}`);
      outcomes.add(key);
    }
  }
  if (!Array.isArray(policy.outcomes) || policy.outcomes.length !== outcomes.size) {
    throw new Error(`policy ${policy.id} outcome table does not cover every target/context`);
  }
  for (const rule of policy.outcomes) {
    const key = `${rule.target}\0${rule.contextId}`;
    if (!outcomes.has(key) || outcomes.delete(key) === false || !singleLine(rule.residual)) {
      throw new Error(`policy ${policy.id} contains an invalid or duplicate outcome`);
    }
    if (rule.result === 'human-approved' && (policy.eligibility !== 'eligible' || rule.effect !== 'apply-target')) {
      throw new Error(`policy ${policy.id} grants human-approved outside an eligible apply-target rule`);
    }
    if (rule.result === 'safe-closed' && rule.effect !== 'apply-target') {
      throw new Error(`policy ${policy.id} grants safe-closed without applying a target`);
    }
    if (rule.effect === 'record-only' && rule.result === 'human-approved') {
      throw new Error(`policy ${policy.id} treats record-only as human-approved`);
    }
  }
  if (outcomes.size !== 0) throw new Error(`policy ${policy.id} has missing outcomes`);
  if (!['no-write', 'record-only'].includes(policy.fallback.effect) || !['recovery-required', 'preserve-failure'].includes(policy.fallback.result) || !singleLine(policy.fallback.residual)) {
    throw new Error(`policy ${policy.id} fallback is invalid`);
  }
}

function validateRegistry(registry: readonly FailurePolicy[] = HUMAN_OVERRIDE_FAILURE_REGISTRY): void {
  const ids = new Set<string>();
  for (const policy of registry) {
    validatePolicy(policy);
    if (ids.has(policy.id)) throw new Error(`duplicate failure policy ${policy.id}`);
    ids.add(policy.id);
  }
  const catalogIds = new Set(stableFailureCatalog.map((item) => item.id));
  if (ids.size !== catalogIds.size || [...catalogIds].some((id) => !ids.has(id))) {
    throw new Error('human override registry does not match the lifecycle producer catalog');
  }
  for (const item of stableFailureCatalog) {
    const policy = registry.find((candidate) => candidate.id === item.id);
    if (!policy || policy.producerId !== item.producerId || policy.guardId !== item.guardId || policy.code !== item.code) {
      throw new Error(`human override policy ${item.id} does not match its producer catalog entry`);
    }
  }
}

validateRegistry();

function policyFor(value: string | FailurePolicy): FailurePolicy | null {
  if (typeof value !== 'string') return value;
  return HUMAN_OVERRIDE_FAILURE_REGISTRY.find((policy) => policy.id === value) ?? null;
}

function resolveOutcome(policyOrId: string | FailurePolicy, requestedTarget: string, observedFacts: readonly string[]): Outcome {
  const policy = policyFor(policyOrId);
  if (!policy || !singleLine(requestedTarget) || !Array.isArray(observedFacts) || observedFacts.some((fact) => !singleLine(fact))) {
    return {
      effect: 'no-write',
      result: 'recovery-required',
      residual: 'failure policy or observed facts were not registered; no target state was written',
      policyId: typeof policyOrId === 'string' ? policyOrId : policyOrId.id,
      target: requestedTarget,
      contextId: 'context-unmatched'
    };
  }
  const allowedContexts = policy.targetContexts[requestedTarget] ?? [];
  const matches = policy.contexts.filter((item) => allowedContexts.includes(item.id)
    && item.facts.length === observedFacts.length
    && item.facts.every((fact) => observedFacts.includes(fact))
    && observedFacts.every((fact) => item.facts.includes(fact)));
  if (matches.length !== 1) {
    return { ...policy.fallback, policyId: policy.id, target: requestedTarget, contextId: 'context-unmatched' };
  }
  const rule = policy.outcomes.find((item) => item.target === requestedTarget && item.contextId === matches[0]!.id);
  if (!rule) return { ...policy.fallback, policyId: policy.id, target: requestedTarget, contextId: 'context-unmatched' };
  return { ...rule, policyId: policy.id };
}

function error(code: string, message: string): OverrideError {
  return { code, message };
}

type ParsedHumanOverrideLedger = Readonly<{
  table: NonNullable<ReturnType<typeof parseTable>>;
  columns: readonly string[];
}>;

function parseHumanOverrideLedger(content: string): ParsedHumanOverrideLedger | null {
  try {
    const table = parseTable(content, {
      sectionAliases: HUMAN_OVERRIDE_SECTION_ALIASES,
      columns: HUMAN_OVERRIDE_COLUMNS,
      keyColumn: 'id'
    });
    return table ? { table, columns: HUMAN_OVERRIDE_COLUMNS } : null;
  } catch (cause) {
    if (!(cause instanceof DocumentMutationError) || cause.code !== 'TABLE_NOT_FOUND') throw cause;
    const table = parseTable(content, {
      sectionAliases: HUMAN_OVERRIDE_SECTION_ALIASES,
      columns: LEGACY_HUMAN_OVERRIDE_COLUMNS,
      keyColumn: 'id'
    });
    return table ? { table, columns: LEGACY_HUMAN_OVERRIDE_COLUMNS } : null;
  }
}

function escapeTableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function migrateHumanOverrideLedger(ledger: ParsedHumanOverrideLedger) {
  if (ledger.columns.includes(PULL_REQUEST_NUMBER_COLUMN)) return null;
  const header = `| ${HUMAN_OVERRIDE_COLUMNS.join(' | ')} |`;
  const separator = `| ${HUMAN_OVERRIDE_COLUMNS.map(() => '---').join(' | ')} |`;
  const rows = ledger.table.rows.map(({ values }) => `| ${HUMAN_OVERRIDE_COLUMNS
    .map((column) => escapeTableCell(values[column] ?? ''))
    .join(' | ')} |`);
  return {
    kind: 'section' as const,
    aliases: HUMAN_OVERRIDE_SECTION_ALIASES,
    heading: ledger.table.heading,
    body: [header, separator, ...rows].join('\n')
  };
}

function validatePullRequestBinding(
  policy: FailurePolicy,
  row: Readonly<Record<string, string>>,
  request: ConsumeHumanOverrideRequest
): OverrideError | null {
  if (policy.producerId !== 'platform.pull-request') return null;
  const bound = toPositiveInteger(row[PULL_REQUEST_NUMBER_COLUMN]);
  if (bound === null) {
    return error('OVERRIDE_RESOURCE_BINDING_MISSING', 'override ticket has no bound pull request number; issue a new ticket');
  }
  if (request.pullRequestNumber !== undefined && request.pullRequestNumber !== bound) {
    return error('OVERRIDE_RESOURCE_MISMATCH', `override ticket is bound to pull request #${bound}`);
  }
  return null;
}

function overrideDryRunConflict(values: Readonly<Record<string, unknown>>): OverrideError | null {
  const hasOverride = ['overrideTicket', 'overrideTarget', 'overrideScope'].some((key) => values[key] !== undefined && values[key] !== '');
  return values.dryRun && hasOverride
    ? error('OVERRIDE_DRY_RUN_CONFLICT', '--dry-run cannot be combined with --override-*')
    : null;
}

function resolveTask(taskRef: string, options: HumanOverrideOptions) {
  return resolveTaskRef(taskRef, { repoRoot: options.repoRoot });
}

function failedIssue(code: string, message: string, taskId: string | null = null): HumanOverrideIssueResult {
  return { status: 'failed', changed: false, ticketId: null, taskId, identity: null, error: error(code, message) };
}

function failedConsume(code: string, message: string, ticketId: string | null = null, taskId: string | null = null): HumanOverrideConsumeResult {
  return { status: 'failed', changed: false, ticketId, taskId, outcome: null, error: error(code, message) };
}

function readTask(taskMdPath: string): { content: string; frontmatter: ReturnType<typeof parseTypedTaskFrontmatter> } | OverrideError {
  try {
    const content = fs.readFileSync(taskMdPath, 'utf8');
    const frontmatter = parseTypedTaskFrontmatter(content);
    return { content, frontmatter };
  } catch (cause) {
    return error('OVERRIDE_DOCUMENT_INVALID', cause instanceof Error ? cause.message : String(cause));
  }
}

function writeOptions(options: HumanOverrideOptions) {
  return {
    repoRoot: options.repoRoot,
    metadataProvider: options.metadataProvider,
    randomSuffix: options.randomSuffix,
    fileSystem: options.taskFileSystem
  };
}

function taskWriteError(result: TaskWriteResult): OverrideError | null {
  return result.status === 'failed' ? error(result.error.code, result.error.message) : null;
}

type ProducerFailure = Readonly<{
  code: string;
  message: string;
  observedFacts: readonly string[];
  state: string;
}>;

function snapshotEvidence(
  taskId: string,
  failureIdValue: string,
  target: string,
  content: string,
  frontmatter: Record<string, unknown> | null,
  producer: ProducerFailure,
  resource: Readonly<{ kind: 'issue' | 'pull-request'; number: number }> | null
): string {
  const stableFrontmatter = frontmatter
    ? Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !['updated_at', 'agent_infra_version', 'status', 'blocked_at', 'completed_at', 'cancelled_at'].includes(key)))
    : { parse: 'invalid' };
  return JSON.stringify({
    taskId,
    failureId: failureIdValue,
    target,
    producer: {
      code: producer.code,
      message: producer.message,
      observedFacts: producer.observedFacts,
      state: producer.state
    },
    resource,
    stableFrontmatter,
    activityLogPresent: locateActivityLog(content) !== null
  });
}

function resourceForSnapshot(
  policy: FailurePolicy,
  options: HumanOverrideOptions,
  frontmatter: Record<string, unknown> | null
): Readonly<{ kind: 'issue' | 'pull-request'; number: number }> | null {
  if (policy.producerId === 'platform.issue') {
    const number = options.probeIssueNumber ?? toPositiveInteger(frontmatter?.issue_number);
    return number === null ? null : { kind: 'issue', number };
  }
  if (policy.producerId === 'platform.pull-request') {
    const fact = frontmatter ? readPrDeliveryFact(frontmatter) : null;
    const number = options.probePullRequestNumber ?? (fact?.status === 'valid' && fact.fact.state === 'bound' ? fact.fact.identity.number : null);
    return number === null ? null : { kind: 'pull-request', number };
  }
  return null;
}

function probeLifecycleFailure(
  taskRef: string,
  policy: FailurePolicy,
  resolved: { taskId: string; state: string },
  options: HumanOverrideOptions
): ProducerFailure | OverrideError {
  if (!options.probeIntent) return error('OVERRIDE_PROBE_INPUT_MISSING', 'an original lifecycle intent is required to prove the producer failure');
  const request = lifecycleRequestFor(
    taskRef,
    options.probeIntent,
    options.probeOperator ?? 'local-operator',
    options.probeReason ?? 'human override producer probe',
    {
      alert_number: options.probeAlertNumber === undefined ? undefined : String(options.probeAlertNumber),
      issue_number: options.probeIssueNumber === undefined ? undefined : String(options.probeIssueNumber),
      staging_dir: options.probeStagingDir
    }
  );
  if ('code' in request) return request;
  const result = applyTaskLifecycle({ ...request, dryRun: true }, {
    repoRoot: options.repoRoot,
    metadataProvider: options.metadataProvider
  });
  if (result.status !== 'failed' || result.error?.code !== policy.code) {
    return error(
      'OVERRIDE_FAILURE_NOT_PRESENT',
      `producer probe returned ${result.error?.code ?? 'no failure'}; expected ${policy.code}`
    );
  }
  const identityConfirmed = result.taskId === resolved.taskId;
  const observedFacts = policy.code === 'SHORT_ID_CAPACITY_EXCEEDED'
    ? identityConfirmed && ['active', 'blocked'].includes(resolved.state)
      ? [SHORT_ID_CONFIRMED]
      : [SHORT_ID_UNCONFIRMED]
    : identityConfirmed ? ['identity-confirmed'] : [];
  return {
    code: result.error.code,
    message: result.error.message,
    observedFacts,
    state: result.sourceState ?? resolved.state
  };
}

type ProbeTask = Readonly<{
  taskId: string;
  state: string;
  taskDir: string;
  repoRoot: string;
}>;

function probeResult(
  policy: FailurePolicy,
  result: unknown,
  state: string
): ProducerFailure | null {
  if (!result || typeof result !== 'object') return null;
  const errorValue = (result as { error?: unknown }).error;
  if (!errorValue || typeof errorValue !== 'object') return null;
  const code = String((errorValue as { code?: unknown }).code ?? '');
  if (code !== policy.code) return null;
  return {
    code,
    message: String((errorValue as { message?: unknown }).message ?? code),
    observedFacts: ['guard-observed'],
    state
  };
}

function probeNotObserved(policy: FailurePolicy): OverrideError {
  return error('OVERRIDE_FAILURE_NOT_PRESENT', `producer ${policy.producerId} did not produce ${policy.code}`);
}

function probePlatformFailure(
  taskRef: string,
  policy: FailurePolicy,
  resolved: ProbeTask,
  options: HumanOverrideOptions
): ProducerFailure | OverrideError {
  let frontmatter: ReturnType<typeof parseTypedTaskFrontmatter>;
  try {
    frontmatter = parseTypedTaskFrontmatter(fs.readFileSync(path.join(resolved.taskDir, 'task.md'), 'utf8'));
  } catch (cause) {
    return error('OVERRIDE_DOCUMENT_INVALID', cause instanceof Error ? cause.message : String(cause));
  }
  const issueNumber = options.probeIssueNumber ?? toPositiveInteger(frontmatter.issue_number);
  const fact = readPrDeliveryFact(frontmatter);
  const pullRequestNumber = options.probePullRequestNumber ?? (fact.status === 'valid' && fact.fact.state === 'bound' ? fact.fact.identity.number : null);
  const operation = policy.producerId === 'platform.issue'
    ? issueNumber === null
      ? null
      : bindPlatformIssue(taskRef, {
        issue: issueNumber,
        agent: options.probeOperator ?? 'local-operator',
        dryRun: true,
        cwd: resolved.repoRoot,
        ...(options.platformClient ? { client: options.platformClient } : {})
      })
    : pullRequestNumber === null
      ? null
      : bindPlatformPullRequest(taskRef, {
        pr: pullRequestNumber,
        agent: options.probeOperator ?? 'local-operator',
        dryRun: true,
        cwd: resolved.repoRoot,
        ...(options.platformClient ? { client: options.platformClient } : {})
      });
  if (!operation) return error('OVERRIDE_PROBE_INPUT_MISSING', `${policy.producerId} requires a bound issue or pull request number`);
  if (operation.status !== 'failed' && operation.status !== 'blocked') return probeNotObserved(policy);
  if (!operation.error) return error('OVERRIDE_PROBE_INPUT_MISSING', `${policy.producerId} returned no platform error evidence`);
  return {
    code: policy.code,
    message: `${operation.error.code}: ${operation.error.message}`,
    observedFacts: ['guard-observed'],
    state: resolved.state
  };
}

function toPositiveInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function probeTaskEventFailure(taskRef: string, policy: FailurePolicy, resolved: ProbeTask): ProducerFailure | OverrideError {
  const starts = [
    'analyze.started', 'review-analysis.started', 'plan.started', 'review-plan.started',
    'code.started', 'review-code.started', 'manual-validation.started', 'validation-run.started'
  ];
  const completions = [
    ['analyze.completed', 'analysis.md'],
    ['review-analysis.completed', 'review-analysis.md'],
    ['plan.completed', 'plan.md'],
    ['review-plan.completed', 'review-plan.md'],
    ['code.completed', 'code.md'],
    ['review-code.completed', 'review-code.md']
  ] as const;
  const candidates: Array<{ event: string; artifact?: string }> = policy.code === 'EVENT_START_MISSING'
    ? completions.map(([event, artifact]) => ({ event, artifact }))
    : starts.map((event) => ({ event }));
  for (const candidate of candidates) {
    const result = applyTaskEvent({
      taskRef,
      event: candidate.event,
      agent: 'codex',
      dryRun: true,
      ...(candidate.artifact ? { artifact: candidate.artifact } : {})
    }, { repoRoot: resolved.repoRoot, lockAlreadyHeld: true });
    const matched = probeResult(policy, result, resolved.state);
    if (matched) return matched;
  }
  return probeNotObserved(policy);
}

function probeVerificationFailure(taskRef: string, policy: FailurePolicy, resolved: ProbeTask): ProducerFailure | OverrideError {
  const result = verifyTaskEvent(
    {
      taskRef,
      event: 'review-code.completed',
      artifact: policy.code === 'VERIFY_ARTIFACT_INVALID' ? 'invalid-artifact.md' : 'review-code.md'
    },
    { repoRoot: resolved.repoRoot }
  );
  const matched = probeResult(policy, result, resolved.state);
  return matched ?? probeNotObserved(policy);
}

function latestArtifact(taskDir: string, family: string): string | undefined {
  let names: string[];
  try { names = fs.readdirSync(taskDir); } catch { return undefined; }
  const candidates = names.filter((name) => (
    name === `${family}.md` || new RegExp(`^${family}-r\\d+\\.md$`).test(name)
  ));
  candidates.sort((a, b) => {
    const round = (name: string) => Number(/-r(\d+)\.md$/.exec(name)?.[1] ?? 1);
    return round(b) - round(a);
  });
  return candidates[0];
}

function probeVerificationEngineFailure(policy: FailurePolicy, resolved: ProbeTask): ProducerFailure | OverrideError {
  const candidates = [
    { skillName: 'review-code', family: 'review-code' },
    { skillName: 'review-plan', family: 'review-plan' },
    { skillName: 'review-analysis', family: 'review-analysis' },
    { skillName: 'code-task', family: 'code' },
    { skillName: 'plan-task', family: 'plan' },
    { skillName: 'analyze-task', family: 'analysis' },
    { skillName: 'complete-task', family: null }
  ];
  for (const candidate of candidates) {
    const artifactFile = candidate.family ? latestArtifact(resolved.taskDir, candidate.family) : undefined;
    if (candidate.family && !artifactFile) continue;
    try {
      const payload = verifyInProcess({
        mode: 'gate',
        skillName: candidate.skillName,
        taskDir: resolved.taskDir,
        artifactFile,
        checks: [],
        repositoryRoot: resolved.repoRoot
      }) as { gate?: unknown };
      const code = payload.gate === 'blocked' ? 'CHECK_BLOCKED' : payload.gate === 'fail' ? 'CHECK_FAILED' : '';
      if (code === policy.code) {
        return {
          code,
          message: `${candidate.skillName} verification gate returned ${payload.gate}`,
          observedFacts: ['guard-observed'],
          state: resolved.state
        };
      }
    } catch {
      // A probe failure is not evidence that the requested verification failure occurred.
    }
  }
  return probeNotObserved(policy);
}

function probeGenericFailure(
  taskRef: string,
  policy: FailurePolicy,
  resolved: ProbeTask,
  options: HumanOverrideOptions = {}
): ProducerFailure | OverrideError {
  switch (policy.producerId) {
    case 'task.resolve':
      return probeNotObserved(policy);
    case 'task.write':
      return probeResult(policy, writeTask({ taskRef, expectedState: 'active', mutations: [], dryRun: true }, { repoRoot: resolved.repoRoot }), resolved.state) ?? probeNotObserved(policy);
    case 'task-event':
      return probeTaskEventFailure(taskRef, policy, resolved);
    case 'task-verify':
      return probeVerificationFailure(taskRef, policy, resolved);
    case 'verification-engine':
      return probeVerificationEngineFailure(policy, resolved);
    case 'activity-intent':
      return probeResult(policy, applyPrReviewActivityIntent({
        kind: 'pr-review-start', taskRef, agent: 'codex', artifact: 'pr-review.md', head: '0'.repeat(40), dryRun: true
      }, { repoRoot: resolved.repoRoot, lockAlreadyHeld: true }), resolved.state) ?? probeNotObserved(policy);
    case 'ledger-intent':
      return probeResult(policy, applyLedgerIntent({
        kind: 'finding-respond', taskRef, id: 'CD-1', round: 1, status: 'accepted', evidence: 'review-code.md#CD-1', dryRun: true
      }), resolved.state) ?? probeNotObserved(policy);
    case 'decision-intent':
      return probeResult(policy, applyHumanDecision({ taskRef, selector: 'CD-1', decision: 'probe', dryRun: true }), resolved.state) ?? probeNotObserved(policy);
    case 'workflow-warning':
      return probeResult(policy, applyWorkflowWarningIntent({
        kind: 'add', taskRef, step: 'probe', severity: 'IMPORTANT', code: 'PROBE', target: 'probe', message: 'probe', action: 'probe', dryRun: true
      }), resolved.state) ?? probeNotObserved(policy);
    case 'review-finalization':
      return probeResult(policy, finalizeReviewSummary({
        taskRef, stage: 'code', artifact: 'review-code.md', dryRun: true
      }, { repoRoot: resolved.repoRoot, lockAlreadyHeld: true }), resolved.state) ?? probeNotObserved(policy);
    case 'lifecycle-execution': {
      const identities = {
        stage: 'code' as const, round: 1, artifact: 'code.md', role: 'executor' as const
      };
      const results = [
        inspectLifecycleExecution(taskRef, { mode: 'standalone', identity: identities, dryRun: true }, { repoRoot: resolved.repoRoot }),
        inspectLifecycleExecution(taskRef, { mode: 'orchestrated', identity: identities, dryRun: true }, { repoRoot: resolved.repoRoot })
      ];
      for (const result of results) {
        const matched = probeResult(policy, result, resolved.state);
        if (matched) return matched;
      }
      return probeNotObserved(policy);
    }
    case 'platform.issue':
    case 'platform.pull-request':
      return probePlatformFailure(taskRef, policy, resolved, options);
    default:
      return error('OVERRIDE_PROBE_INPUT_MISSING', `no producer probe is registered for ${policy.producerId}`);
  }
}

function isProducerFailure(value: ProducerFailure | OverrideError): value is ProducerFailure {
  return 'observedFacts' in value && 'state' in value && Array.isArray(value.observedFacts);
}

function captureFailureSnapshot(taskRef: string, failureIdValue: string, target: string, options: HumanOverrideOptions = {}): FailureSnapshot | OverrideError {
  const policy = policyFor(failureIdValue);
  if (!policy) return error('OVERRIDE_FAILURE_UNKNOWN', `failure policy '${failureIdValue}' is not registered`);
  if (!policy.targets.includes(target)) return error('OVERRIDE_TARGET_INVALID', `target '${target}' is not registered for ${failureIdValue}`);
  const resolved = resolveTask(taskRef, options);
  if (!resolved.ok) return error(resolved.code, resolved.message);
  let content: string;
  try {
    content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  } catch (cause) {
    return error('OVERRIDE_DOCUMENT_INVALID', cause instanceof Error ? cause.message : String(cause));
  }
  let frontmatter: Record<string, unknown> | null = null;
  try { frontmatter = parseTypedTaskFrontmatter(content); } catch { /* probe reports an unconfirmed identity */ }
  const producer: ProducerFailure | OverrideError = policy.producerId === LIFECYCLE_PRODUCER
    ? probeLifecycleFailure(taskRef, policy, resolved, options)
    : probeGenericFailure(taskRef, policy, resolved, options);
  if (!isProducerFailure(producer)) return producer;
  const digest = computeFailureDigest(snapshotEvidence(
    resolved.taskId,
    failureIdValue,
    target,
    content,
    frontmatter,
    producer,
    resourceForSnapshot(policy, options, frontmatter)
  ));
  const [producerId, ...codeParts] = failureIdValue.split(':');
  const code = codeParts.join(':');
  return {
    schema: '1',
    taskId: resolved.taskId,
    failureId: failureIdValue,
    producerId: producerId ?? '',
    code,
    target,
    state: producer.state,
    digest,
    observedFacts: producer.observedFacts,
    message: producer.message,
    capturedAt: (options.now ?? canonicalTimestamp)(),
    source: 'producer-result'
  };
}

function isOverrideError(value: FailureSnapshot | OverrideError): value is OverrideError {
  return !('schema' in value);
}

function validateSnapshot(snapshot: FailureSnapshot, expected: FailureSnapshot): OverrideError | null {
  if (
    snapshot.schema !== '1' || snapshot.source !== 'producer-result' ||
    snapshot.taskId !== expected.taskId || snapshot.failureId !== expected.failureId ||
    snapshot.producerId !== expected.producerId || snapshot.code !== expected.code ||
    snapshot.target !== expected.target || snapshot.digest !== expected.digest ||
    snapshot.state !== expected.state || snapshot.message !== expected.message ||
    snapshot.observedFacts.length !== expected.observedFacts.length ||
    snapshot.observedFacts.some((fact, index) => fact !== expected.observedFacts[index])
  ) return error('OVERRIDE_SNAPSHOT_MISMATCH', 'failure snapshot is not the canonical producer probe result');
  return null;
}

function validateCommon(request: HumanOverrideRequest): OverrideError | null {
  const fields = [request.taskRef, request.failureId, request.target, request.operator, request.reason, request.scope, request.expiresAt];
  if (fields.some((value) => !singleLine(value))) return error('OVERRIDE_PAYLOAD_INVALID', 'override fields must be non-empty single-line values');
  if (request.identitySource !== undefined && request.identitySource !== 'local-declared') {
    return error('OVERRIDE_IDENTITY_SOURCE_INVALID', 'the local override entrypoint owns identity_source=local-declared');
  }
  return null;
}

function validateResourceNumbers(request: HumanOverrideRequest): OverrideError | null {
  const values = [
    ['alertNumber', request.alertNumber],
    ['issueNumber', request.issueNumber],
    ['pullRequestNumber', request.pullRequestNumber]
  ] as const;
  for (const [name, value] of values) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      return error('OVERRIDE_RESOURCE_INVALID', `${name} must be a safe positive integer`);
    }
  }
  return null;
}

function issueHumanOverride(request: HumanOverrideRequest, options: HumanOverrideOptions = {}): HumanOverrideIssueResult {
  const invalid = validateCommon(request);
  if (invalid) return failedIssue(invalid.code, invalid.message);
  const policy = policyFor(request.failureId);
  if (!policy) return failedIssue('OVERRIDE_FAILURE_UNKNOWN', `failure policy '${request.failureId}' is not registered`);
  if (!policy.targets.includes(request.target)) return failedIssue('OVERRIDE_TARGET_INVALID', `target '${request.target}' is not registered for ${request.failureId}`);
  const invalidResource = validateResourceNumbers(request);
  if (invalidResource) return failedIssue(invalidResource.code, invalidResource.message);
  const recordOnly = policy.outcomes.some((rule) => rule.target === request.target && rule.effect === 'record-only' && rule.result === 'preserve-failure');
  if (policy.eligibility === 'never-overridable' && !recordOnly) return failedIssue('OVERRIDE_NOT_ELIGIBLE', `failure '${request.failureId}' is never overridable`);
  const issuedAt = (options.now ?? canonicalTimestamp)();
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(request.expiresAt);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs <= issuedMs) {
    return failedIssue('OVERRIDE_EXPIRY_INVALID', 'expiresAt must be a valid time after issuedAt');
  }
  const resolved = resolveTask(request.taskRef, options);
  if (!resolved.ok) return failedIssue(resolved.code, resolved.message, resolved.taskId);
  const document = readTask(resolved.taskMdPath);
  if ('code' in document) return failedIssue(document.code, document.message, resolved.taskId);
  if (document.frontmatter.id !== resolved.taskId) return failedIssue('OVERRIDE_DOCUMENT_INVALID', 'task frontmatter id does not match resolved task', resolved.taskId);
  const snapshotResult = captureFailureSnapshot(request.taskRef, request.failureId, request.target, {
    ...options,
    probeIntent: request.intent,
    probeOperator: request.operator,
    probeReason: request.reason,
    probeAlertNumber: request.alertNumber,
    probeIssueNumber: request.issueNumber,
    probePullRequestNumber: request.pullRequestNumber,
    probeStagingDir: request.stagingDir
  });
  if (isOverrideError(snapshotResult)) return failedIssue(snapshotResult.code, snapshotResult.message, resolved.taskId);
  const snapshot = snapshotResult as FailureSnapshot;
  if (request.failureSnapshot) {
    const snapshotError = validateSnapshot(request.failureSnapshot, snapshot);
    if (snapshotError) return failedIssue(snapshotError.code, snapshotError.message, resolved.taskId);
  }
  if (request.failureDigest !== undefined && request.failureDigest !== snapshot.digest) {
    return failedIssue('OVERRIDE_DIGEST_MISMATCH', 'caller-provided failure digest does not match the producer probe', resolved.taskId);
  }
  let ledger: ParsedHumanOverrideLedger | null = null;
  try {
    ledger = parseHumanOverrideLedger(document.content);
  } catch (cause) {
    return failedIssue('OVERRIDE_DOCUMENT_INVALID', cause instanceof Error ? cause.message : String(cause), resolved.taskId);
  }
  const ticketId = (options.randomId ?? randomUUID)();
  if (!singleLine(ticketId)) return failedIssue('OVERRIDE_PAYLOAD_INVALID', 'ticket id generator returned an invalid id', resolved.taskId);
  const mutations = [] as Array<
    | { kind: 'section'; aliases: readonly string[]; heading: string; body: string }
    | { kind: 'table-row'; sectionAliases: readonly string[]; columns: readonly string[]; keyColumn: string; key: string; action: 'upsert'; values: Readonly<Record<string, string>> }
  >;
  if (!ledger) {
    const header = `| ${HUMAN_OVERRIDE_COLUMNS.join(' | ')} |`;
    const separator = `| ${HUMAN_OVERRIDE_COLUMNS.map(() => '---').join(' | ')} |`;
    mutations.push({
      kind: 'section',
      aliases: HUMAN_OVERRIDE_SECTION_ALIASES,
      heading: 'Human Override Ledger',
      body: `${header}\n${separator}`
    });
  } else {
    const migration = migrateHumanOverrideLedger(ledger);
    if (migration) mutations.push(migration);
  }
  const [producerId, ...codeParts] = request.failureId.split(':');
  const code = codeParts.join(':');
  mutations.push({
    kind: 'table-row',
    sectionAliases: HUMAN_OVERRIDE_SECTION_ALIASES,
    columns: HUMAN_OVERRIDE_COLUMNS,
    keyColumn: 'id',
    key: ticketId,
    action: 'upsert',
    values: {
      schema: '1',
      failure_id: request.failureId,
      producer_id: producerId ?? '',
      code,
      target: request.target,
      operator: request.operator,
      identity_source: 'local-declared',
      verified: 'false',
      reason: request.reason,
      scope: request.scope,
      intent: request.intent ?? '',
      failure_message: snapshot.message,
      failure_digest: snapshot.digest,
      context_id: snapshot.observedFacts[0] ?? 'context-unmatched',
      effect: '',
      source_state: resolved.state,
      issued_at: issuedAt,
      expires_at: request.expiresAt,
      status: 'issued',
      result: '',
      consumed_at: '',
      residual: '',
      alert_number: request.alertNumber === undefined ? '' : String(request.alertNumber),
      issue_number: request.issueNumber === undefined ? '' : String(request.issueNumber),
      pull_request_number: request.pullRequestNumber === undefined ? '' : String(request.pullRequestNumber),
      staging_dir: request.stagingDir ?? ''
    }
  });
  const result = writeTask({ taskRef: request.taskRef, expectedState: resolved.state, mutations }, writeOptions(options));
  const writeError = taskWriteError(result);
  if (writeError) return failedIssue(writeError.code, writeError.message, resolved.taskId);
  if (result.status === 'failed') return failedIssue(result.error.code, result.error.message, resolved.taskId);
  if (result.status === 'planned') return failedIssue('OVERRIDE_WRITE_INVALID', 'override writes cannot be planned', resolved.taskId);
  return {
    status: result.status,
    changed: result.changed,
    ticketId,
    taskId: resolved.taskId,
    identity: { source: 'local-declared', operator: request.operator, verified: false },
    error: null
  };
}

function lifecycleRequestFor(
  taskRef: string,
  intent: string,
  operator: string,
  reason: string,
  values: Readonly<Record<string, string | undefined>> = {}
): TaskLifecycleRequest | OverrideError {
  if (!['block', 'activate', 'cancel', 'complete', 'restore', 'close-codescan', 'close-dependabot'].includes(intent)) {
    return error('OVERRIDE_EFFECT_INPUT_MISSING', 'a lifecycle intent is required to apply this override outcome');
  }
  if (intent === 'block') return { taskRef, intent: 'block', agent: operator, reason, unblockCondition: 'manual override recovery' };
  if (intent === 'activate') return { taskRef, intent: 'activate', agent: operator, note: `manual override: ${reason}` };
  if (intent === 'cancel') return { taskRef, intent: 'cancel', agent: operator, reason };
  if (intent === 'complete') return { taskRef, intent: 'complete', agent: operator };
  if (intent === 'close-codescan' || intent === 'close-dependabot') {
    const alertNumber = Number(values.alert_number);
    if (!Number.isSafeInteger(alertNumber) || alertNumber < 1) return error('OVERRIDE_EFFECT_INPUT_MISSING', `${intent} requires the original alert number`);
    return { taskRef, intent, agent: operator, alertNumber, reason };
  }
  const issueNumber = Number(values.issue_number);
  const stagingDir = values.staging_dir;
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || !stagingDir) return error('OVERRIDE_EFFECT_INPUT_MISSING', 'restore requires the original staging directory and issue number');
  return { taskRef, intent: 'restore', agent: operator, stagingDir, issueNumber };
}

function applyOutcomeEffect(
  request: ConsumeHumanOverrideRequest,
  row: Readonly<Record<string, string>>,
  snapshot: FailureSnapshot,
  outcome: Outcome,
  options: HumanOverrideOptions
): OverrideError | null {
  if (outcome.effect === 'no-write' || outcome.effect === 'record-only') return null;
  const intent = outcome.target === 'safe-close' ? 'cancel' : row.intent || request.intent;
  if (!intent && outcome.target === 'continue-local') {
    if (!options.effectExecutor) return error('OVERRIDE_EFFECT_EXECUTOR_MISSING', 'the producer must supply an effect executor for a continue-local outcome');
    return options.effectExecutor({
      failureId: request.failureId,
      operator: row.operator ?? 'local-operator',
      reason: row.reason ?? snapshot.message
    });
  }
  if (!intent) return error('OVERRIDE_EFFECT_INPUT_MISSING', 'the ticket has no original lifecycle intent for its retry effect');
  const lifecycleRequest = lifecycleRequestFor(request.taskRef, intent, row.operator ?? 'local-operator', row.reason ?? snapshot.message, row);
  if ('code' in lifecycleRequest) return lifecycleRequest;
  const result = applyTaskLifecycle(lifecycleRequest, {
    repoRoot: options.repoRoot,
    metadataProvider: options.metadataProvider,
    manualOverride: { failureId: request.failureId, operator: row.operator ?? 'local-operator', reason: row.reason ?? snapshot.message }
  });
  if (result.status === 'failed') {
    return error('OVERRIDE_EFFECT_FAILED', `${result.error?.code ?? 'LIFECYCLE_FAILED'}: ${result.error?.message ?? 'manual outcome effect failed'}`);
  }
  return null;
}

function ticketMutation(
  ticketId: string,
  row: Readonly<Record<string, string>>,
  outcome: Outcome,
  status: 'consuming' | 'consumed',
  timestamp: string,
  residual: string,
  columns: readonly string[]
) {
  const values: Record<string, string> = {
    schema: row.schema ?? '',
    failure_id: row.failure_id ?? '',
    producer_id: row.producer_id ?? '',
    code: row.code ?? '',
    target: row.target ?? '',
    operator: row.operator ?? '',
    identity_source: row.identity_source ?? '',
    verified: row.verified ?? '',
    reason: row.reason ?? '',
    scope: row.scope ?? '',
    intent: row.intent ?? '',
    failure_message: row.failure_message ?? '',
    failure_digest: row.failure_digest ?? '',
    context_id: outcome.contextId,
    effect: outcome.effect,
    source_state: row.source_state ?? '',
    issued_at: row.issued_at ?? '',
    expires_at: row.expires_at ?? '',
    status,
    result: outcome.result,
    consumed_at: status === 'consumed' ? timestamp : '',
    residual,
    alert_number: row.alert_number ?? '',
    issue_number: row.issue_number ?? '',
    staging_dir: row.staging_dir ?? ''
  };
  if (columns.includes(PULL_REQUEST_NUMBER_COLUMN)) values[PULL_REQUEST_NUMBER_COLUMN] = row[PULL_REQUEST_NUMBER_COLUMN] ?? '';
  return {
    kind: 'table-row' as const,
    sectionAliases: HUMAN_OVERRIDE_SECTION_ALIASES,
    columns,
    keyColumn: 'id',
    key: ticketId,
    action: 'upsert' as const,
    values
  };
}

function outcomeFromConsumingRow(policy: FailurePolicy, row: Readonly<Record<string, string>>, target: string): Outcome | OverrideError {
  const contextId = row.context_id;
  if (!contextId || !row.effect || !row.result || !row.residual) {
    return error('OVERRIDE_RECOVERY_INVALID', 'consuming override ticket has incomplete effect state');
  }
  const outcome = resolveOutcome(policy, target, [contextId]);
  if (
    outcome.contextId !== contextId || outcome.effect !== row.effect || outcome.result !== row.result ||
    outcome.residual !== row.residual.replace(/^effect pending: /, '')
  ) {
    return error('OVERRIDE_RECOVERY_INVALID', 'consuming override ticket does not match its registered outcome');
  }
  return outcome;
}

function snapshotFromTicket(taskId: string, row: Readonly<Record<string, string>>): FailureSnapshot | OverrideError {
  const [producerId, ...codeParts] = (row.failure_id ?? '').split(':');
  if (!producerId || codeParts.length === 0 || !row.failure_digest || !row.failure_message || !row.source_state) {
    return error('OVERRIDE_RECOVERY_INVALID', 'consuming override ticket has incomplete failure evidence');
  }
  return {
    schema: '1',
    taskId,
    failureId: row.failure_id,
    producerId,
    code: codeParts.join(':'),
    target: row.target,
    state: row.source_state,
    digest: row.failure_digest,
    observedFacts: row.context_id ? [row.context_id] : [],
    message: row.failure_message,
    capturedAt: row.issued_at,
    source: 'producer-result'
  };
}

function consumeHumanOverride(request: ConsumeHumanOverrideRequest, options: HumanOverrideOptions = {}): HumanOverrideConsumeResult {
  const values = [request.taskRef, request.ticketId, request.failureId, request.target, request.scope];
  if (values.some((value) => !singleLine(value))) {
    return failedConsume('OVERRIDE_PAYLOAD_INVALID', 'consume fields must be non-empty single-line values', request.ticketId || null);
  }
  const policy = policyFor(request.failureId);
  if (!policy) return failedConsume('OVERRIDE_FAILURE_UNKNOWN', `failure policy '${request.failureId}' is not registered`, request.ticketId);
  if (!policy.targets.includes(request.target)) return failedConsume('OVERRIDE_TARGET_INVALID', `target '${request.target}' is not registered for ${request.failureId}`, request.ticketId);
  const resolved = resolveTask(request.taskRef, options);
  if (!resolved.ok) return failedConsume(resolved.code, resolved.message, request.ticketId, resolved.taskId);
  const document = readTask(resolved.taskMdPath);
  if ('code' in document) return failedConsume(document.code, document.message, request.ticketId, resolved.taskId);
  if (document.frontmatter.id !== resolved.taskId) return failedConsume('OVERRIDE_DOCUMENT_INVALID', 'task frontmatter id does not match resolved task', request.ticketId, resolved.taskId);
  let ledger: ParsedHumanOverrideLedger | null;
  try {
    ledger = parseHumanOverrideLedger(document.content);
  } catch (cause) {
    return failedConsume('OVERRIDE_DOCUMENT_INVALID', cause instanceof Error ? cause.message : String(cause), request.ticketId, resolved.taskId);
  }
  if (!ledger) return failedConsume('OVERRIDE_NOT_FOUND', `override ledger is missing for ticket '${request.ticketId}'`, request.ticketId, resolved.taskId);
  const row = ledger.table.rows.find((item) => item.values.id === request.ticketId);
  if (!row) return failedConsume('OVERRIDE_NOT_FOUND', `override ticket '${request.ticketId}' was not found`, request.ticketId, resolved.taskId);
  if (row.values.status === 'consumed') return failedConsume('OVERRIDE_REPLAY', `override ticket '${request.ticketId}' was already consumed`, request.ticketId, resolved.taskId);
  const recovering = row.values.status === 'consuming';
  if (row.values.status !== 'issued' && !recovering) return failedConsume('OVERRIDE_STATUS_INVALID', `override ticket '${request.ticketId}' is not issued`, request.ticketId, resolved.taskId);
  if (row.values.failure_id !== request.failureId) return failedConsume('OVERRIDE_FAILURE_MISMATCH', 'ticket failure identity does not match consume request', request.ticketId, resolved.taskId);
  if (row.values.target !== request.target) return failedConsume('OVERRIDE_TARGET_INVALID', 'ticket target does not match consume request', request.ticketId, resolved.taskId);
  if (row.values.scope !== request.scope) return failedConsume('OVERRIDE_SCOPE_MISMATCH', 'ticket scope does not match consume request', request.ticketId, resolved.taskId);
  const resourceError = validatePullRequestBinding(policy, row.values, request);
  if (resourceError) return failedConsume(resourceError.code, resourceError.message, request.ticketId, resolved.taskId);
  let snapshot: FailureSnapshot;
  if (recovering) {
    const recoverySnapshot = snapshotFromTicket(resolved.taskId, row.values);
    if (isOverrideError(recoverySnapshot)) return failedConsume(recoverySnapshot.code, recoverySnapshot.message, request.ticketId, resolved.taskId);
    snapshot = recoverySnapshot;
  } else {
    const snapshotResult = captureFailureSnapshot(request.taskRef, request.failureId, request.target, {
      ...options,
      probeIntent: row.values.intent ? row.values.intent as TaskLifecycleIntent : request.intent,
      probeOperator: row.values.operator,
      probeReason: row.values.reason,
      probeAlertNumber: row.values.alert_number ? Number(row.values.alert_number) : undefined,
      probeIssueNumber: row.values.issue_number ? Number(row.values.issue_number) : undefined,
      probePullRequestNumber: row.values.pull_request_number ? Number(row.values.pull_request_number) : undefined,
      probeStagingDir: row.values.staging_dir || undefined
    });
    if (isOverrideError(snapshotResult)) return failedConsume(snapshotResult.code, snapshotResult.message, request.ticketId, resolved.taskId);
    snapshot = snapshotResult as FailureSnapshot;
    if (request.failureSnapshot) {
      const snapshotError = validateSnapshot(request.failureSnapshot, snapshot);
      if (snapshotError) return failedConsume(snapshotError.code, snapshotError.message, request.ticketId, resolved.taskId);
    }
    if (request.failureDigest !== undefined && request.failureDigest !== snapshot.digest) return failedConsume('OVERRIDE_DIGEST_MISMATCH', 'caller-provided failure digest does not match the producer result', request.ticketId, resolved.taskId);
    if (row.values.failure_digest !== snapshot.digest) return failedConsume('OVERRIDE_DIGEST_MISMATCH', 'ticket failure digest does not match the producer result', request.ticketId, resolved.taskId);
    if (request.observedFacts && (request.observedFacts.length !== snapshot.observedFacts.length || request.observedFacts.some((fact, index) => fact !== snapshot.observedFacts[index]))) {
      return failedConsume('OVERRIDE_FACTS_MISMATCH', 'caller-provided facts do not match the producer result', request.ticketId, resolved.taskId);
    }
    if (row.values.source_state && row.values.source_state !== snapshot.state) {
      return failedConsume('OVERRIDE_SNAPSHOT_STALE', 'the task no longer has the state captured when the ticket was issued', request.ticketId, resolved.taskId);
    }
  }
  const now = (options.now ?? canonicalTimestamp)();
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(row.values.expires_at ?? '');
  if (!recovering && (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs) || expiresMs <= nowMs)) return failedConsume('OVERRIDE_EXPIRED', `override ticket '${request.ticketId}' is expired`, request.ticketId, resolved.taskId);
  const resolvedOutcome = recovering ? outcomeFromConsumingRow(policy, row.values, request.target) : resolveOutcome(policy, request.target, snapshot.observedFacts);
  if ('code' in resolvedOutcome) return failedConsume(resolvedOutcome.code, resolvedOutcome.message, request.ticketId, resolved.taskId);
  const outcome = resolvedOutcome;
  let effectRow = row.values;
  if (!recovering && outcome.effect !== 'no-write' && outcome.effect !== 'record-only') {
    const staged = writeTask({
      taskRef: request.taskRef,
      expectedState: resolved.state,
      mutations: [ticketMutation(request.ticketId, row.values, outcome, 'consuming', now, `effect pending: ${outcome.residual}`, ledger.columns)]
    }, writeOptions(options));
    const stagedError = taskWriteError(staged);
    if (stagedError) return failedConsume(stagedError.code, stagedError.message, request.ticketId, resolved.taskId);
    if (staged.status === 'failed') return failedConsume(staged.error.code, staged.error.message, request.ticketId, resolved.taskId);
    if (staged.status === 'planned') return failedConsume('OVERRIDE_WRITE_INVALID', 'override writes cannot be planned', request.ticketId, resolved.taskId);
    effectRow = { ...row.values, status: 'consuming', effect: outcome.effect, result: outcome.result, context_id: outcome.contextId, residual: `effect pending: ${outcome.residual}` };
  }
  const effectError = applyOutcomeEffect(request, effectRow, snapshot, outcome, options);
  if (effectError) return failedConsume(effectError.code, effectError.message, request.ticketId, resolved.taskId);
  const after = resolveTask(request.taskRef, options);
  if (!after.ok) return failedConsume(after.code, after.message, request.ticketId, after.taskId);
  const mutation = ticketMutation(request.ticketId, effectRow, outcome, 'consumed', now, outcome.residual, ledger.columns);
  const result = writeTask({ taskRef: request.taskRef, expectedState: after.state, mutations: [mutation] }, writeOptions(options));
  const writeError = taskWriteError(result);
  if (writeError) return failedConsume(writeError.code, writeError.message, request.ticketId, resolved.taskId);
  if (result.status === 'failed') return failedConsume(result.error.code, result.error.message, request.ticketId, resolved.taskId);
  if (result.status === 'planned') return failedConsume('OVERRIDE_WRITE_INVALID', 'override writes cannot be planned', request.ticketId, resolved.taskId);
  return {
    status: result.status,
    changed: result.changed,
    ticketId: request.ticketId,
    taskId: resolved.taskId,
    outcome,
    ...(outcome.effect !== 'record-only' && outcome.effect !== 'no-write'
      ? { manualOverride: { failureId: request.failureId, operator: row.values.operator ?? 'local-operator', reason: row.values.reason ?? snapshot.message } }
      : {}),
    error: null
  };
}

function diagnoseHumanOverride(failure: string, target?: string) {
  const policy = policyFor(failure);
  if (!policy) return { status: 'failed' as const, changed: false as const, error: error('OVERRIDE_FAILURE_UNKNOWN', `failure policy '${failure}' is not registered`) };
  return {
    status: 'ready' as const,
    changed: false as const,
    failure: policy,
    target: target ?? null,
    outcomes: target ? policy.outcomes.filter((rule) => rule.target === target) : policy.outcomes,
    error: null
  };
}

function diagnoseHumanOverrideForTask(
  taskRef: string,
  failure?: string,
  target?: string,
  options: HumanOverrideOptions = {}
) {
  const resolved = resolveTask(taskRef, options);
  if (!resolved.ok) {
    return {
      status: 'failed' as const,
      changed: false as const,
      taskId: resolved.taskId,
      state: null,
      blockedBy: [],
      probes: [],
      error: error(resolved.code, resolved.message)
    };
  }
  const document = readTask(resolved.taskMdPath);
  if ('code' in document) {
    return {
      status: 'failed' as const,
      changed: false as const,
      taskId: resolved.taskId,
      state: resolved.state,
      blockedBy: [],
      probes: [],
      error: document
    };
  }
  const policies = failure
    ? [policyFor(failure)].filter((policy): policy is FailurePolicy => policy !== null)
    : HUMAN_OVERRIDE_FAILURE_REGISTRY;
  if (failure && policies.length === 0) {
    return {
      status: 'failed' as const,
      changed: false as const,
      taskId: resolved.taskId,
      state: resolved.state,
      blockedBy: [],
      probes: [],
      error: error('OVERRIDE_FAILURE_UNKNOWN', `failure policy '${failure}' is not registered`)
    };
  }
  const probes = policies
    .filter((policy) => !target || policy.targets.includes(target))
    .map((policy) => {
      const producer = policy.producerId === LIFECYCLE_PRODUCER
        ? probeLifecycleFailure(taskRef, policy, resolved, options)
    : probeGenericFailure(taskRef, policy, resolved, options);
      const observed = isProducerFailure(producer);
      return {
        failureId: policy.id,
        producerId: policy.producerId,
        guardId: policy.guardId,
        code: policy.code,
        target: target && policy.targets.includes(target) ? target : policy.targets[0]!,
        eligibility: policy.eligibility,
        status: observed ? 'observed' as const : producer.code === 'OVERRIDE_PROBE_INPUT_MISSING' ? 'unproven' as const : 'not-observed' as const,
        observedFacts: observed ? producer.observedFacts : [],
        message: observed ? producer.message : producer.message,
        errorCode: observed ? null : producer.code
      };
    });
  const blockedBy = probes.filter((probe) => probe.status === 'observed');
  return {
    status: 'ready' as const,
    changed: false as const,
    taskId: resolved.taskId,
    state: resolved.state,
    snapshot: {
      taskId: resolved.taskId,
      state: resolved.state,
      documentDigest: computeFailureDigest(document.content)
    },
    blockedBy,
    probes,
    error: null
  };
}

function renderHumanOverrideAudit(content: string): string {
  let ledger: ParsedHumanOverrideLedger | null;
  try {
    ledger = parseHumanOverrideLedger(content);
  } catch {
    return '';
  }
  if (!ledger || ledger.table.rows.length === 0) return '';
  const rows = ledger.table.rows.map(({ values }) => [
    `- ${values.status || 'unknown'}: ${values.failure_id || 'unknown failure'}`,
    values.pull_request_number ? `resource=pull-request#${values.pull_request_number}` : values.issue_number ? `resource=issue#${values.issue_number}` : 'resource=local',
    `target=${values.target || 'unknown'}`,
    `context=${values.context_id || 'unknown'}`,
    `effect=${values.effect || 'unknown'}`,
    `result=${values.result || 'pending'}`,
    `operator=${values.operator || 'unknown'}`,
    `identity_source=${values.identity_source || 'unknown'}`,
    `reason=${values.reason || 'not recorded'}`,
    `residual=${values.residual || 'pending'}`
  ].join('; '));
  return `## Human Override Audit\n\n${rows.join('\n')}`;
}

function computeFailureDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export {
  HUMAN_OVERRIDE_COLUMNS,
  HUMAN_OVERRIDE_FAILURE_REGISTRY,
  HUMAN_OVERRIDE_SECTION_ALIASES,
  LIFECYCLE_PRODUCER,
  computeFailureDigest,
  captureFailureSnapshot,
  consumeHumanOverride,
  diagnoseHumanOverride,
  diagnoseHumanOverrideForTask,
  failureId,
  issueHumanOverride,
  overrideDryRunConflict,
  renderHumanOverrideAudit,
  resolveOutcome,
  stableFailureCatalog,
  validatePolicy,
  validateRegistry
};
export type {
  ConsumeHumanOverrideRequest,
  Eligibility,
  FailureIdentity,
  FailurePolicy,
  HumanOverrideConsumeResult,
  HumanOverrideIdentity,
  HumanOverrideIssueResult,
  HumanOverrideOptions,
  HumanOverrideRequest,
  FailureSnapshot,
  Outcome,
  OutcomeContext,
  OutcomeEffect,
  OutcomeFallback,
  OutcomeResult,
  OutcomeRule
};
