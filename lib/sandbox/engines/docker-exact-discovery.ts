import type { SpawnSyncReturns } from 'node:child_process';
import { commandForEngine, runProbe } from '../shell.ts';
import { commandForSandboxAuthority, type SandboxAuthorityEvidenceV1 } from './authority.ts';

type ProbeResult = SpawnSyncReturns<string | Buffer>;
type Probe = (cmd: string, args: string[], options?: { timeout?: number }) => ProbeResult;

export type ExactContainerDiscovery =
  | Readonly<{ state: 'absent'; id: string; evidence: 'exact-empty' }>
  | Readonly<{
    state: 'found';
    id: string;
    running: boolean;
    labels: Readonly<Record<string, string>>;
    evidence: 'exact-present';
  }>
  | Readonly<{ state: 'conflict'; reason: string }>
  | Readonly<{ state: 'unknown'; reason: string }>;

export type ExactContainerDiscoveryOptions = Readonly<{
  probe?: Probe;
  timeoutMs?: number;
  authority?: SandboxAuthorityEvidenceV1;
}>;

const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/u;

function outputText(value: string | Buffer | null | undefined): string {
  return typeof value === 'string' ? value : value?.toString('utf8') ?? '';
}

function unknown(reason: string): ExactContainerDiscovery {
  return { state: 'unknown', reason };
}

export function buildExactContainerListArgs(id: string): string[] {
  if (!FULL_CONTAINER_ID.test(id)) throw new Error('SANDBOX_CONTAINER_ID_NOT_FULL');
  return ['container', 'ls', '--all', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}'];
}

function buildExactContainerInspectArgs(id: string): string[] {
  return ['container', 'inspect', '--format', '{{json .}}', id];
}

function runDockerProbe(
  engine: string,
  args: string[],
  options: ExactContainerDiscoveryOptions
): ProbeResult {
  const command = options.authority
    ? commandForSandboxAuthority(options.authority, 'docker', args)
    : commandForEngine(engine, 'docker', args);
  return (options.probe ?? runProbe)(
    command.cmd,
    command.args,
    options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }
  );
}

function parseExactList(stdout: string, expectedId: string): 'empty' | 'present' | 'conflict' | string {
  const rows = stdout.split(/\r?\n/u).map((row) => row.trim()).filter(Boolean);
  if (rows.length === 0) return 'empty';
  if (rows.length !== 1) return 'exact container query returned multiple rows';
  if (!FULL_CONTAINER_ID.test(rows[0]!)) return 'exact container query returned a malformed ID';
  if (rows[0] !== expectedId) return 'conflict';
  return 'present';
}

function parseExactInspect(stdout: string, expectedId: string): ExactContainerDiscovery {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return unknown('exact container inspection returned malformed JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return unknown('exact container inspection returned an incomplete object');
  }
  const inspected = value as {
    Id?: unknown;
    State?: { Running?: unknown };
    Config?: { Labels?: unknown };
  };
  if (inspected.Id !== expectedId || typeof inspected.State?.Running !== 'boolean'
    || !inspected.Config?.Labels || typeof inspected.Config.Labels !== 'object'
    || Array.isArray(inspected.Config.Labels)) {
    return unknown('exact container inspection identity is incomplete');
  }
  const rawLabels = inspected.Config.Labels as Record<string, unknown>;
  if (Object.values(rawLabels).some((value) => typeof value !== 'string')) {
    return unknown('exact container inspection labels are malformed');
  }
  return {
    state: 'found',
    id: expectedId,
    running: inspected.State.Running,
    labels: { ...rawLabels as Record<string, string> },
    evidence: 'exact-present'
  };
}

export function discoverExactContainer(
  engine: string,
  id: string,
  options: ExactContainerDiscoveryOptions = {}
): ExactContainerDiscovery {
  if (!FULL_CONTAINER_ID.test(id)) return unknown('container identity is not a full 64-character ID');
  let listed: ProbeResult;
  try {
    listed = runDockerProbe(engine, buildExactContainerListArgs(id), options);
  } catch {
    return unknown('exact container query failed before producing a result');
  }
  if (listed.status !== 0) {
    return unknown(`exact container query exited with ${listed.status ?? 'unknown status'}`);
  }
  const listState = parseExactList(outputText(listed.stdout), id);
  if (listState === 'empty') return { state: 'absent', id, evidence: 'exact-empty' };
  if (listState === 'conflict') return { state: 'conflict', reason: 'exact container query returned a different ID' };
  if (listState !== 'present') return unknown(listState);

  let inspected: ProbeResult;
  try {
    inspected = runDockerProbe(engine, buildExactContainerInspectArgs(id), options);
  } catch {
    return unknown('exact container inspection failed before producing a result');
  }
  if (inspected.status !== 0) {
    return unknown(`exact container inspection exited with ${inspected.status ?? 'unknown status'}`);
  }
  return parseExactInspect(outputText(inspected.stdout).trim(), id);
}
