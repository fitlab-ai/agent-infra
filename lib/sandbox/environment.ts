import fs from 'node:fs';
import path from 'node:path';
import { readSandboxControlIdentitySentinel } from './control/identity-sentinel.ts';

export type SandboxControlTransportDecision = Readonly<{
  kind: 'direct-host' | 'sandbox-local' | 'broker-client' | 'fail-closed';
  reasonCode: string | null;
}>;

export const SANDBOX_CONTROL_STATUS_MOUNT = '/run/agent-infra/control-status';

const TASK_MARKER_KEYS = [
  'AGENT_INFRA_SANDBOX',
  'AGENT_INFRA_TASK_ID',
  'AGENT_INFRA_CONTROL_TOKEN',
  'AGENT_INFRA_CONTROL_GENERATION',
  'AGENT_INFRA_CONTROL_DIR',
  'AGENT_INFRA_CONTROL_STATUS_DIR',
  'AGENT_INFRA_RUNTIME_DIR'
] as const;
const TASK_CONTROL_MARKER_KEYS = [
  'AGENT_INFRA_CONTROL_TOKEN',
  'AGENT_INFRA_CONTROL_GENERATION',
  'AGENT_INFRA_CONTROL_DIR',
  'AGENT_INFRA_CONTROL_STATUS_DIR'
] as const;
const TASK_CONTROL_CONFIG_KEYS = [
  ...TASK_CONTROL_MARKER_KEYS,
  'AGENT_INFRA_CONTROL_ROOT_ID'
] as const;

type NativeDirectoryProbe = 'present' | 'absent' | 'unknown';

function nativeDirectoryProbe(candidate: string): NativeDirectoryProbe {
  if (process.platform === 'linux') {
    try {
      // Linux sandboxes use this fixed mount as a host/sandbox trust anchor.
      // Do not let a preload replace the ordinary node:fs probe and select host routing.
      const binding = (process as unknown as {
        binding(name: string): { internalModuleStat(filePath: string): number }
      }).binding('fs');
      if (!Function.prototype.toString.call(binding.internalModuleStat).includes('[native code]')) return 'unknown';
      const result = binding.internalModuleStat(candidate);
      if (result === 1) return 'present';
      if (result === -2) return 'absent';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isDirectory() && !stat.isSymbolicLink() ? 'present' : 'unknown';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error
      && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return 'absent';
    return 'unknown';
  }
}

export type TaskMarkerState = 'none' | 'branch-only' | 'task-bound' | 'incomplete';

export function sandboxTaskMarkerState(env: NodeJS.ProcessEnv): TaskMarkerState {
  const present = (key: typeof TASK_MARKER_KEYS[number]) => Boolean(env[key]);
  const sandbox = env.AGENT_INFRA_SANDBOX === '1';
  const taskId = present('AGENT_INFRA_TASK_ID');
  const controls = TASK_CONTROL_MARKER_KEYS.every(present);
  const runtime = present('AGENT_INFRA_RUNTIME_DIR');
  const any = TASK_MARKER_KEYS.some(present);
  if (!any) return 'none';
  if (!sandbox || !controls) return 'incomplete';
  if (taskId && runtime) return 'task-bound';
  if (!taskId && !runtime) return 'branch-only';
  return 'incomplete';
}

export function hasTaskBoundMarker(env: NodeJS.ProcessEnv = process.env): boolean {
  return sandboxTaskMarkerState(env) === 'task-bound';
}

export function hasSandboxControlMarker(env: NodeJS.ProcessEnv = process.env): boolean {
  return TASK_CONTROL_MARKER_KEYS.some((key) => Boolean(env[key]));
}

export function resolveSandboxControlTransport(
  env: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ statusMountPath?: string; localWorkflow?: boolean }> = {}
): SandboxControlTransportDecision {
  const markerState = sandboxTaskMarkerState(env);
  const hasAnyMarker = markerState !== 'none'
    || Boolean(env.AGENT_INFRA_CONTROL_CONTROLLER_BINDING)
    || Boolean(env.AGENT_INFRA_EXECUTOR_MANIFEST);
  const fixedStatusDir = options.statusMountPath ?? SANDBOX_CONTROL_STATUS_MOUNT;
  const fixedStatusProbe = path.isAbsolute(fixedStatusDir)
    ? nativeDirectoryProbe(fixedStatusDir) : 'absent';
  if (fixedStatusProbe === 'unknown') {
    return { kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_IDENTITY_UNAVAILABLE' };
  }
  const fixedStatusMounted = fixedStatusProbe === 'present';
  if (!hasAnyMarker) {
    return fixedStatusMounted
      ? { kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_CONFIGURATION_INCOMPLETE' }
      : { kind: 'direct-host', reasonCode: null };
  }
  if (markerState === 'incomplete') {
    return { kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_CONFIGURATION_INCOMPLETE' };
  }
  const hasCompleteConfig = TASK_CONTROL_CONFIG_KEYS.every((key) => Boolean(env[key]));
  if (!hasCompleteConfig) {
    return { kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_CONFIGURATION_INCOMPLETE' };
  }
  const configuredStatusDir = env.AGENT_INFRA_CONTROL_STATUS_DIR;
  const configuredStatusProbe = configuredStatusDir && path.isAbsolute(configuredStatusDir)
    ? nativeDirectoryProbe(configuredStatusDir) : 'absent';
  if (configuredStatusProbe === 'unknown') {
    return { kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_IDENTITY_UNAVAILABLE' };
  }
  const statusDir = configuredStatusDir && path.isAbsolute(configuredStatusDir)
    ? configuredStatusProbe === 'present' ? configuredStatusDir : null
    : fixedStatusMounted ? fixedStatusDir : null;
  const statusMounted = statusDir !== null;
  if (env.AGENT_INFRA_EXECUTOR_MANIFEST || env.AGENT_INFRA_CONTROL_CONTROLLER_BINDING) {
    return { kind: 'fail-closed', reasonCode: 'TASK_CONTROL_TRANSPORT_INVALID' };
  }
  const taskBound = Boolean(env.AGENT_INFRA_TASK_ID);
  const runtime = Boolean(env.AGENT_INFRA_RUNTIME_DIR);
  if (statusMounted) {
    let sentinel;
    try {
      sentinel = readSandboxControlIdentitySentinel(statusDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return { kind: 'fail-closed', reasonCode: message.endsWith('MISSING')
        ? 'SANDBOX_CONTROL_IDENTITY_MISSING'
        : 'SANDBOX_CONTROL_IDENTITY_MALFORMED' };
    }
    if (sentinel.generation !== env.AGENT_INFRA_CONTROL_GENERATION) {
      return { kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_IDENTITY_GENERATION_MISMATCH' };
    }
    if (sentinel.controlRootId !== env.AGENT_INFRA_CONTROL_ROOT_ID) {
      return { kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_IDENTITY_ROOT_ID_MISMATCH' };
    }
    if (sentinel.mode === 'task-bound'
      && (sentinel.taskId !== env.AGENT_INFRA_TASK_ID || !runtime)) {
      return { kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_IDENTITY_TOPOLOGY_MISMATCH' };
    }
    if (sentinel.mode === 'branch-only' && (taskBound || runtime)) {
      return { kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_IDENTITY_TOPOLOGY_MISMATCH' };
    }
    return { kind: options.localWorkflow ? 'sandbox-local' : 'broker-client', reasonCode: null };
  }
  return { kind: 'fail-closed', reasonCode: 'SANDBOX_CONTROL_IDENTITY_MISSING' };
}

export function isSandbox(
  env: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ statusMountPath?: string }> = {}
): boolean {
  const decision = resolveSandboxControlTransport(env, options);
  if (decision.kind === 'fail-closed') throw new Error(decision.reasonCode ?? 'TASK_CONTROL_TRANSPORT_INVALID');
  return decision.kind !== 'direct-host';
}
