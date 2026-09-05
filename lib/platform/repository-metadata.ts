import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { PlatformClient, LoadedContext } from './context.ts';
import { resolvePlatformProviderContext } from './context.ts';
import {
  providerError,
  providerOperationContext,
  providerStatus
} from './provider-bridge.ts';
import type {
  LabelDefinition,
  LabelReconciliation,
  MilestoneDefinition,
  MilestoneInitialization,
  PlatformError,
  ProviderResult
} from './provider-contract.ts';
import { platformResult } from './types.ts';
import type { PlatformResult } from './types.ts';

type RepositoryMetadataOptions = {
  cwd?: string;
  client?: PlatformClient;
  platformType?: string;
};

type MilestoneBaseline = {
  version: string;
  source: string;
};

type MilestonePlan = {
  baseline: MilestoneBaseline;
  history: boolean;
  desired: MilestoneDefinition[];
};

type LabelsResult = PlatformResult & {
  operation: 'init-labels';
  labels: {
    commonCount: number;
    inCount: number;
    created: string[];
    updated: string[];
    removed: string[];
    skipped: string[];
  };
};

type MilestonesResult = PlatformResult & {
  operation: 'init-milestones';
  milestones: {
    baseline: MilestoneBaseline | null;
    history: boolean;
    desired: string[];
    created: string[];
    skipped: string[];
  };
};

const COMMON_LABELS: readonly LabelDefinition[] = [
  { name: 'type: bug', color: 'DED6F9', description: 'A general bug' },
  { name: 'type: enhancement', color: 'DED6F9', description: 'A general enhancement' },
  { name: 'type: feature', color: 'DED6F9', description: 'A general feature' },
  { name: 'type: documentation', color: 'DED6F9', description: 'A documentation task' },
  { name: 'type: dependency-upgrade', color: 'DED6F9', description: 'A dependency upgrade' },
  { name: 'type: task', color: 'DED6F9', description: 'A general task' },
  { name: 'status: waiting-for-triage', color: 'FCF1C4', description: "An issue we've not yet triaged or decided on" },
  { name: 'status: waiting-for-feedback', color: 'FCF1C4', description: 'We need additional information before we can continue' },
  { name: 'status: feedback-provided', color: 'FCF1C4', description: 'Feedback has been provided' },
  { name: 'status: feedback-reminder', color: 'FCF1C4', description: "We've sent a reminder that we need additional information before we can continue" },
  { name: 'status: pending-design-work', color: 'FCF1C4', description: 'Needs design work before any code can be developed' },
  { name: 'status: in-progress', color: 'FCF1C4', description: 'Work is actively being developed' },
  { name: 'status: on-hold', color: 'FCF1C4', description: "We can't start working on this issue yet" },
  { name: 'status: blocked', color: 'FCF1C4', description: "An issue that's blocked on an external project change" },
  { name: 'status: declined', color: 'FCF1C4', description: "A suggestion or change that we don't feel we should currently apply" },
  { name: 'status: duplicate', color: 'FCF1C4', description: 'A duplicate of another issue' },
  { name: 'status: invalid', color: 'FCF1C4', description: "An issue that we don't feel is valid" },
  { name: 'status: superseded', color: 'FCF1C4', description: 'An issue that has been superseded by another' },
  { name: 'status: bulk-closed', color: 'FCF1C4', description: "An outdated, unresolved issue that's closed in bulk as part of a cleaning process" },
  { name: 'status: ideal-for-contribution', color: 'FCF1C4', description: 'An issue that a contributor can help us with' },
  { name: 'status: backported', color: 'FCF1C4', description: 'An issue that has been backported to maintenance branches' },
  { name: 'status: waiting-for-internal-feedback', color: 'FCF1C4', description: 'An issue that needs input from a member or another team' },
  { name: 'good first issue', color: 'F9D9E6', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'dependencies', color: '0366D6', description: 'Pull requests that update a dependency file' }
];

type ParsedVersion = {
  tag: string;
  major: string;
  minor: string;
  patch: string;
  prerelease: string;
};

function validIdentifiers(value: string, prerelease: boolean): boolean {
  if (!value) return false;
  return value.split('.').every((identifier) =>
    /^[0-9A-Za-z-]+$/.test(identifier)
    && (!prerelease || !/^\d+$/.test(identifier) || /^(0|[1-9]\d*)$/.test(identifier))
  );
}

function parseVersionTag(tag: string): ParsedVersion | null {
  if (!tag.startsWith('v')) return null;
  let version = tag.slice(1);
  const plusAt = version.indexOf('+');
  if (plusAt >= 0) {
    const build = version.slice(plusAt + 1);
    if (!validIdentifiers(build, false)) return null;
    version = version.slice(0, plusAt);
  }

  let prerelease = '';
  const dashAt = version.indexOf('-');
  if (dashAt >= 0) {
    prerelease = version.slice(dashAt + 1);
    if (!validIdentifiers(prerelease, true)) return null;
    version = version.slice(0, dashAt);
  }

  const core = version.split('.');
  if (core.length !== 3 || !core.every((part) => /^(0|[1-9]\d*)$/.test(part))) return null;
  return { tag, major: core[0]!, minor: core[1]!, patch: core[2]!, prerelease };
}

function compareDecimal(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

function compareAscii(left: string, right: string): number {
  const alphabet = '+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    const leftRank = alphabet.indexOf(left[index]!);
    const rightRank = alphabet.indexOf(right[index]!);
    if (leftRank !== rightRank) return leftRank > rightRank ? 1 : -1;
  }
  if (left.length === right.length) return 0;
  return left.length > right.length ? 1 : -1;
}

function comparePrerelease(left: string, right: string): number {
  if (!left || !right) {
    if (left === right) return 0;
    return left ? -1 : 1;
  }
  const leftIds = left.split('.');
  const rightIds = right.split('.');
  const limit = Math.min(leftIds.length, rightIds.length);
  for (let index = 0; index < limit; index += 1) {
    const leftId = leftIds[index]!;
    const rightId = rightIds[index]!;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    const comparison = leftNumeric && rightNumeric
      ? compareDecimal(leftId, rightId)
      : leftNumeric !== rightNumeric
        ? leftNumeric ? -1 : 1
        : compareAscii(leftId, rightId);
    if (comparison !== 0) return comparison;
  }
  if (leftIds.length === rightIds.length) return 0;
  return leftIds.length > rightIds.length ? 1 : -1;
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const [leftPart, rightPart] of [
    [left.major, right.major],
    [left.minor, right.minor],
    [left.patch, right.patch]
  ] as const) {
    const comparison = compareDecimal(leftPart, rightPart);
    if (comparison !== 0) return comparison;
  }
  const prerelease = comparePrerelease(left.prerelease, right.prerelease);
  return prerelease !== 0 ? prerelease : compareAscii(left.tag, right.tag);
}

function incrementDecimal(value: string): string {
  const digits = value.split('');
  let carry = 1;
  for (let index = digits.length - 1; index >= 0 && carry; index -= 1) {
    const next = Number(digits[index]!) + carry;
    digits[index] = String(next % 10);
    carry = next === 10 ? 1 : 0;
  }
  return carry ? `1${digits.join('')}` : digits.join('');
}

function buildMilestonePlan(tags: readonly string[], history: boolean): MilestonePlan {
  const parsed = tags.flatMap((tag) => {
    const version = parseVersionTag(tag);
    return version ? [version] : [];
  });
  const selected = parsed.reduce<ParsedVersion | null>((best, candidate) =>
    !best || compareVersions(candidate, best) > 0 ? candidate : best, null);
  const baseline: MilestoneBaseline = selected
    ? { version: `${selected.major}.${selected.minor}.${selected.patch}`, source: `git tag ${selected.tag}` }
    : { version: '0.1.0', source: 'compatibility default' };
  const [major, minor, patch] = baseline.version.split('.');
  const desired: MilestoneDefinition[] = [];
  const titles = new Set<string>();
  const add = (title: string, description: string, state: 'open' | 'closed') => {
    if (titles.has(title)) return;
    titles.add(title);
    desired.push({ title, description, state });
  };

  const line = `${major}.${minor}.x`;
  const version = selected
    ? `${major}.${minor}.${incrementDecimal(patch!)}`
    : baseline.version;
  add('General Backlog', 'All unsorted backlogged tasks may be completed in a future version.', 'open');
  add(line, `Issues that we want to resolve in ${major}.${minor} line.`, 'open');
  add(version, `Issues that we want to release in v${version}.`, 'open');
  if (patch === '0') {
    const nextMinor = `${major}.${incrementDecimal(minor!)}.0`;
    const nextLine = `${major}.${incrementDecimal(minor!)}.x`;
    add(nextMinor, `Issues that we want to release in v${nextMinor}.`, 'open');
    add(nextLine, `Issues that we want to resolve in ${major}.${incrementDecimal(minor!)} line.`, 'open');
  }

  if (history) {
    for (const historical of parsed) {
      const historicalVersion = `${historical.major}.${historical.minor}.${historical.patch}`;
      add(`${historical.major}.${historical.minor}.x`, `Issues that we want to resolve in ${historical.major}.${historical.minor} line.`, 'open');
      add(historicalVersion, `Issues that we want to release in v${historicalVersion}.`, 'closed');
    }
  }
  return { baseline, history, desired };
}

function buildLabelDefinitions(config: unknown): LabelDefinition[] {
  const labels = config && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>).labels
    : undefined;
  const mapping = labels && typeof labels === 'object' && !Array.isArray(labels)
    ? (labels as Record<string, unknown>).in
    : undefined;
  if (mapping === undefined) return [...COMMON_LABELS];
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('labels.in must be an object');
  const dynamic = Object.keys(mapping).sort().map((key) => {
    if (!key || /[\r\n\t]/.test(key)) throw new Error('labels.in keys must be non-empty single-line values');
    return { name: `in: ${key}`, color: 'BFD4F2', description: `Module label for ${key}` };
  });
  return [...COMMON_LABELS, ...dynamic];
}

function configAt(root: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.agents', '.airc.json'), 'utf8')) as unknown;
  } catch {
    return {};
  }
}

function baseResult<T extends PlatformResult>(
  status: PlatformResult['status'],
  context: PlatformResult,
  extra: Partial<T> = {}
): T {
  return {
    ...platformResult(status, {
      platform: context.platform,
      capabilities: context.capabilities,
      operations: context.operations,
      error: context.error
    }),
    ...extra
  } as T;
}

function unsupported(providerType: string, operation: string): PlatformError {
  return {
    code: 'PLATFORM_CAPABILITY_UNSUPPORTED',
    message: `Platform '${providerType}' does not provide ${operation}`,
    retryable: false
  };
}

function operationStatus(changed: boolean): 'applied' | 'no-op' {
  return changed ? 'applied' : 'no-op';
}

function errorStatus(error: PlatformError): PlatformResult['status'] {
  return error.code === 'PLATFORM_CAPABILITY_UNSUPPORTED' ? 'degraded' : providerStatus(error);
}

function initialLabelsResult(context: PlatformResult, labels: LabelDefinition[]): LabelsResult {
  return baseResult<LabelsResult>('degraded', context, {
    operation: 'init-labels',
    labels: {
      commonCount: COMMON_LABELS.length,
      inCount: labels.filter((item) => item.name.startsWith('in:')).length,
      created: [], updated: [], removed: [], skipped: []
    },
    error: context.error || { code: 'PLATFORM_CAPABILITY_UNSUPPORTED', message: 'Label initialization is unavailable', retryable: false }
  });
}

function initialMilestonesResult(context: PlatformResult, history: boolean): MilestonesResult {
  return baseResult<MilestonesResult>('degraded', context, {
    operation: 'init-milestones',
    milestones: { baseline: null, history, desired: [], created: [], skipped: [] },
    error: context.error || { code: 'PLATFORM_CAPABILITY_UNSUPPORTED', message: 'Milestone initialization is unavailable', retryable: false }
  });
}

function usableContext(loaded: { ok: true; value: LoadedContext } | { ok: false; context: PlatformResult }): loaded is { ok: true; value: LoadedContext } {
  return loaded.ok && Boolean(loaded.value.context.platform.repository);
}

async function initializeLabels(
  input: { cleanupStaleIn?: boolean } = {},
  options: RepositoryMetadataOptions = {}
): Promise<LabelsResult> {
  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd, client: options.client, platformType: options.platformType });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  let definitions: LabelDefinition[];
  try {
    definitions = buildLabelDefinitions(loaded.ok ? configAt(loaded.value.repositoryRoot) : {});
  } catch (error) {
    return {
      ...initialLabelsResult(context, []),
      status: 'failed',
      error: { code: 'LABEL_CONFIG_INVALID', message: error instanceof Error ? error.message : String(error), retryable: false }
    };
  }
  const initial = initialLabelsResult(context, definitions);
  if (!usableContext(loaded)) return { ...initial, error: initial.error || context.error };
  const operation = loaded.value.provider.repositoryMetadata?.reconcileLabels;
  if (!operation) return { ...initial, error: unsupported(loaded.value.provider.type, 'repositoryMetadata.reconcileLabels') };
  const reconciled: ProviderResult<LabelReconciliation> = await operation({
    context: providerOperationContext(loaded.value),
    desired: definitions,
    cleanupStaleIn: input.cleanupStaleIn === true,
    mutation: { idempotencyKey: 'labels:init' }
  });
  if (!reconciled.ok) return {
    ...initial,
    status: errorStatus(reconciled.error),
    error: providerError(reconciled.error, 'LABEL_INITIALIZATION_FAILED')
  };
  return {
    ...initial,
    status: operationStatus(reconciled.value.changed),
    changed: reconciled.value.changed,
    operations: [{ name: 'reconcile-labels', status: operationStatus(reconciled.value.changed), reasonCode: null }],
    labels: {
      commonCount: COMMON_LABELS.length,
      inCount: definitions.length - COMMON_LABELS.length,
      created: reconciled.value.created,
      updated: reconciled.value.updated,
      removed: reconciled.value.removed,
      skipped: reconciled.value.skipped
    },
    error: null
  };
}

function gitTags(cwd: string): string[] {
  const output = execFileSync('git', ['tag', '--list', 'v*'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

async function initializeMilestones(
  input: { history?: boolean } = {},
  options: RepositoryMetadataOptions = {}
): Promise<MilestonesResult> {
  const history = input.history === true;
  const loaded = await resolvePlatformProviderContext({ cwd: options.cwd, client: options.client, platformType: options.platformType });
  const context = loaded.ok ? loaded.value.context : loaded.context;
  const initial = initialMilestonesResult(context, history);
  if (!usableContext(loaded)) return initial;
  let plan: MilestonePlan;
  try {
    plan = buildMilestonePlan(gitTags(loaded.value.workingDirectory), history);
  } catch (error) {
    return {
      ...initial,
      status: 'failed',
      error: { code: 'MILESTONE_TAG_DISCOVERY_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false }
    };
  }
  const operation = loaded.value.provider.repositoryMetadata?.reconcileMilestones;
  if (!operation) return {
    ...initial,
    milestones: { ...initial.milestones, baseline: plan.baseline, history, desired: plan.desired.map((item) => item.title) },
    error: unsupported(loaded.value.provider.type, 'repositoryMetadata.reconcileMilestones')
  };
  const reconciled = await operation({
    context: providerOperationContext(loaded.value),
    desired: plan.desired,
    mutation: { idempotencyKey: `milestones:init:${plan.baseline.version}:${history}` }
  });
  if (!reconciled.ok) return {
    ...initial,
    status: errorStatus(reconciled.error),
    milestones: { ...initial.milestones, baseline: plan.baseline, history, desired: plan.desired.map((item) => item.title) },
    error: providerError(reconciled.error, 'MILESTONE_INITIALIZATION_FAILED')
  };
  return {
    ...initial,
    status: operationStatus(reconciled.value.changed),
    changed: reconciled.value.changed,
    operations: [{ name: 'reconcile-milestones', status: operationStatus(reconciled.value.changed), reasonCode: null }],
    milestones: {
      baseline: plan.baseline,
      history,
      desired: plan.desired.map((item) => item.title),
      created: reconciled.value.created,
      skipped: reconciled.value.skipped
    },
    error: null
  };
}

export { buildLabelDefinitions, buildMilestonePlan, initializeLabels, initializeMilestones };
export type { LabelsResult, MilestoneBaseline, MilestonePlan, MilestonesResult, RepositoryMetadataOptions };
