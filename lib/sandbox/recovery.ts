import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nodeEntryArgs } from './control/executor.ts';
import {
  containerNameCandidates,
  sandboxBranchLabel,
  sandboxLabel,
  sandboxRuntimeCapabilityLabel,
  sandboxTaskIdLabel,
  sandboxWorkspaceModeLabel,
  worktreeDirCandidates
} from './constants.ts';
import { isAgentClientId } from '../agent-clients/types.ts';
import {
  createSandboxCapabilityPlan
} from './agent-client-reconciler.ts';
import type {
  SandboxRecoveryFindingDescriptor,
  SandboxRecoveryRepair
} from './tool-types.ts';
import type { SandboxConfig } from './config.ts';
import { toEnginePath } from './engines/wsl2-paths.ts';
import { sandboxCoreBindMounts } from './mounts.ts';
import {
  assertSandboxTaskSource,
  sandboxControlPaths,
  sandboxWorkspaceViewPaths
} from './workspace-view.ts';
import {
  parseSandboxWorkspaceIdentity,
  sameSandboxWorkspaceIdentity,
  type SandboxContainerWorkspaceIdentity,
  type SandboxWorkspaceIdentity
} from './workspace-identity.ts';
import { inspectWorktree, type WorktreeSnapshot } from './worktree-safety.ts';
import { runEngine, runOkEngine, runVerboseEngine } from './shell.ts';
import {
  declaredTmpfsSeedEntries,
  resolveTools,
  toolConfigDirCandidates,
  type SandboxTool,
  type TmpfsSeedEntry
} from './tools.ts';
import {
  fetchSandboxRows,
  selectSandboxContainer,
  startSandboxContainer,
  type SandboxRow
} from './commands/list-running.ts';
import { getProcessStartTime, processIdentityMatches, removePidFileIfMatches } from '../server/process-state.ts';
import {
  acquireSandboxControlBrokerStartup,
  isSandboxControlRootQuiescing
} from './control/lifecycle.ts';
import {
  appendSandboxControlAudit,
  readSandboxControlStatus
} from './control/state.ts';
import {
  SANDBOX_CONTROL_FUTURE_SKEW_MS,
  SANDBOX_CONTROL_STATUS_STALE_MS,
  type SandboxControlManifest
} from './control/protocol.ts';

export type SandboxRecoveryFinding = {
  repairKind: 'permissions' | 'missing-seed' | 'builtin-link' | 'hard-failure';
  code?: string;
  message: string;
  path?: string;
  seed?: TmpfsSeedEntry;
  repair?: SandboxRecoveryRepair;
};

type SandboxAgentClientCheckSnapshot = {
  adapterId: string;
  checkId: string;
  applicable: boolean;
  healthy: boolean;
  finding: SandboxRecoveryFindingDescriptor;
  repair?: SandboxRecoveryRepair;
};

export type SandboxRecoverySnapshot = {
  identityOk: boolean;
  containerIdValid: boolean;
  expectedBranch: string;
  actualBranch: string | null;
  expectedWorkspace: SandboxWorkspaceIdentity;
  actualWorkspace: SandboxContainerWorkspaceIdentity;
  runtimeCapabilityOk?: boolean;
  unexpectedCapabilityMounts?: string[];
  mounts: Array<{
    path: string;
    expectedType: string;
    actualType: string | null;
    expectedSource: string | null;
    actualSource: string | null;
    sourceMatches: boolean;
    expectedRW: boolean;
    actualRW: boolean | null;
    sourceAccessible: boolean;
  }>;
  tmpfs: Array<{ path: string; permissionsOk: boolean; writable: boolean }>;
  seeds: Array<{
    toolId: string;
    containerMount?: string;
    stagingPath: string;
    targetPath: string;
    mounted: boolean;
    targetState: 'ok' | 'missing' | 'wrong-type' | 'inaccessible';
  }>;
  aliasesReadable: boolean;
  agentClientChecks: SandboxAgentClientCheckSnapshot[];
};

export type SandboxReadyResult = {
  container: string;
  path: 'healthy' | 'recovered' | 'recreated';
  warnings: string[];
};

type DockerMount = {
  Type?: unknown;
  Source?: unknown;
  Destination?: unknown;
  RW?: unknown;
};

type DockerInspection = {
  Id?: unknown;
  Config?: { Labels?: Record<string, string> };
  HostConfig?: { Tmpfs?: unknown };
  Mounts?: DockerMount[];
};

type RecoveryCommandDeps = {
  run?: typeof runEngine;
  runOk?: typeof runOkEngine;
  runVerbose?: typeof runVerboseEngine;
  start?: typeof startSandboxContainer;
  fetchRows?: typeof fetchSandboxRows;
  ensureControlBroker?: () => void | Promise<void>;
};

type EnsureSandboxReadyParams = {
  config: SandboxConfig;
  engine: string;
  branch: string;
  workspace?: SandboxWorkspaceIdentity;
  row: SandboxRow;
  allowRecreate?: boolean;
  recreate?: (branch: string) => Promise<void>;
  writeWarning?: (message: string) => void;
  deps?: RecoveryCommandDeps;
};

type ExpectedMount = {
  path: string;
  expectedType: 'bind' | 'tmpfs';
  hostPaths: string[];
  expectedRW: boolean;
};

async function waitForSandboxControlBrokerStatus(params: {
  root: string;
  statusDir: string;
  generation: string;
  pid: number;
  startTime?: string;
}, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isSandboxControlRootQuiescing(params.root)) throw new Error('SANDBOX_CONTROL_QUIESCING');
    try {
      const status = readSandboxControlStatus(params.statusDir);
      if (status.generation === params.generation && status.broker.pid === params.pid
        && (!params.startTime || status.broker.startTime === params.startTime)
        && Date.now() - status.updatedAt <= SANDBOX_CONTROL_STATUS_STALE_MS
        && status.updatedAt <= Date.now() + SANDBOX_CONTROL_FUTURE_SKEW_MS) return;
    } catch {
      // The broker may still be publishing its initial atomic status.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('SANDBOX_CONTROL_BROKER_START_TIMEOUT');
}

export async function startSandboxControlBroker(repoRoot: string, manifestPath: string): Promise<void> {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const extension = path.extname(fileURLToPath(import.meta.url));
  const internalCli = path.resolve(directory, '..', '..', 'bin', `internal-cli${extension}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SandboxControlManifest;
  const root = path.dirname(manifestPath);
  if (isSandboxControlRootQuiescing(root)) throw new Error('SANDBOX_CONTROL_QUIESCING');
  const brokerPath = path.join(root, 'broker.json');
  let brokerSnapshot: string | null = null;
  let replacedBrokerRecord = false;
  try {
    brokerSnapshot = fs.readFileSync(brokerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (brokerSnapshot !== null) {
    type ExistingBrokerRecord = {
      version?: unknown;
      pid?: unknown;
      startTime?: unknown;
      token?: unknown;
      generation?: unknown;
    };
    let broker: ExistingBrokerRecord | null = null;
    try {
      broker = JSON.parse(brokerSnapshot) as ExistingBrokerRecord;
    } catch {
      // Malformed owner records are stale and replaced below.
    }
    const owner = broker !== null && typeof broker.pid === 'number' && typeof broker.startTime === 'string'
      ? { version: 1 as const, pid: broker.pid, startTime: broker.startTime }
      : null;
    const live = owner !== null && processIdentityMatches(owner);
    if (
      live
      && owner !== null
      && broker !== null
      && broker.version === 2
      && broker.token === manifest.token
      && broker.generation === manifest.generation
    ) {
      await waitForSandboxControlBrokerStatus({
        root,
        statusDir: manifest.publicStatusDir,
        generation: manifest.generation,
        pid: owner.pid,
        startTime: owner.startTime
      });
      return;
    }
    if (live && owner) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        try {
          if (fs.readFileSync(brokerPath, 'utf8') !== brokerSnapshot) {
            return startSandboxControlBroker(repoRoot, manifestPath);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return startSandboxControlBroker(repoRoot, manifestPath);
          }
          throw error;
        }
        if (!processIdentityMatches(owner)) {
          removePidFileIfMatches(brokerPath, brokerSnapshot);
          return startSandboxControlBroker(repoRoot, manifestPath);
        }
      }
      throw new Error('SANDBOX_CONTROL_BROKER_OWNER_ACTIVE');
    }
  }
  const startupStartTime = getProcessStartTime(process.pid);
  if (!startupStartTime) throw new Error('SANDBOX_CONTROL_BROKER_IDENTITY_UNAVAILABLE');
  const releaseStartup = await acquireSandboxControlBrokerStartup(root, {
    pid: process.pid,
    startTime: startupStartTime
  });
  let child: ReturnType<typeof spawn>;
  try {
    const currentBroker = fs.existsSync(brokerPath) ? fs.readFileSync(brokerPath, 'utf8') : null;
    if (currentBroker !== brokerSnapshot) return startSandboxControlBroker(repoRoot, manifestPath);
    if (brokerSnapshot !== null) {
      replacedBrokerRecord = removePidFileIfMatches(brokerPath, brokerSnapshot);
      if (!replacedBrokerRecord && fs.existsSync(brokerPath)) {
        throw new Error('SANDBOX_CONTROL_BROKER_OWNER_TRANSITION');
      }
    }
    if (replacedBrokerRecord) {
      appendSandboxControlAudit(manifest, 'broker-observed-crash');
      appendSandboxControlAudit(manifest, 'broker-restart');
    }
    child = spawn(
      process.execPath,
      nodeEntryArgs(internalCli, ['sandbox-control', 'serve', '--manifest', manifestPath]),
      { cwd: repoRoot, detached: true, stdio: 'ignore' }
    );
  } finally {
    releaseStartup();
  }
  let spawnError: Error | null = null;
  child.once('error', (error) => { spawnError = error; });
  child.unref();
  if (!child.pid) throw new Error('SANDBOX_CONTROL_BROKER_START_FAILED');
  try {
    await waitForSandboxControlBrokerStatus({
      root,
      statusDir: manifest.publicStatusDir,
      generation: manifest.generation,
      pid: child.pid
    });
  } catch (error) {
    child.kill('SIGTERM');
    if (spawnError) throw spawnError;
    throw error;
  }
}

async function ensureSandboxControlBroker(params: {
  config: SandboxConfig;
  container: string;
  workspace: SandboxWorkspaceIdentity;
}): Promise<void> {
  const control = sandboxControlPaths({
    base: params.config.controlBase ?? path.join(params.config.home, '.agent-infra', 'sandbox-control'),
    project: params.config.project,
    container: params.container,
    identity: params.workspace
  });
  if (!fs.existsSync(control.manifestPath)) return;
  const manifest = JSON.parse(fs.readFileSync(control.manifestPath, 'utf8')) as SandboxControlManifest;
  if (manifest.version !== 3) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_VERSION_INVALID: expected version 3; container-only recreation is required');
  }
  const brokerPath = path.join(control.root, 'broker.json');
  try {
    const broker = JSON.parse(fs.readFileSync(brokerPath, 'utf8')) as {
      version?: unknown;
      pid?: unknown;
      startTime?: unknown;
      token?: unknown;
      generation?: unknown;
    };
    if (
      broker.version === 2
      && typeof broker.pid === 'number'
      && typeof broker.startTime === 'string'
      && broker.token === manifest.token
      && broker.generation === manifest.generation
      && processIdentityMatches({ version: 1, pid: broker.pid, startTime: broker.startTime })
    ) {
      try {
        const status = readSandboxControlStatus(control.statusDir);
        if (status.generation === manifest.generation && status.broker.pid === broker.pid
          && status.broker.startTime === broker.startTime
          && Date.now() - status.updatedAt <= SANDBOX_CONTROL_STATUS_STALE_MS
          && status.updatedAt <= Date.now() + SANDBOX_CONTROL_FUTURE_SKEW_MS) return;
      } catch {
        // A verified live owner may still be publishing its initial status.
      }
      await waitForSandboxControlBrokerStatus({
        root: control.root,
        statusDir: control.statusDir,
        generation: manifest.generation,
        pid: broker.pid,
        startTime: broker.startTime
      });
      return;
    }
  } catch {
    // A missing, stale, or malformed broker record is replaced below.
  }
  await startSandboxControlBroker(params.config.repoRoot, control.manifestPath);
}

function findingKey(finding: SandboxRecoveryFinding): string {
  return `${finding.repairKind}:${finding.path ?? finding.seed?.targetPath ?? finding.message}`;
}

export function classifySandboxRecovery(snapshot: SandboxRecoverySnapshot): SandboxRecoveryFinding[] {
  const findings: SandboxRecoveryFinding[] = [];
  if (!snapshot.identityOk) {
    const branchOnly = snapshot.containerIdValid
      && snapshot.actualBranch === snapshot.expectedBranch
      && snapshot.expectedWorkspace.mode === 'task-bound'
      && snapshot.actualWorkspace.mode === 'branch-only';
    const expectedIdentity = snapshot.expectedWorkspace.mode === 'task-bound'
      ? `task-bound:${snapshot.expectedWorkspace.taskId}`
      : snapshot.expectedWorkspace.mode;
    const actualIdentity = snapshot.actualWorkspace.mode === 'task-bound'
      ? `task-bound:${snapshot.actualWorkspace.taskId}`
      : snapshot.actualWorkspace.mode;
    findings.push({
      repairKind: 'hard-failure',
      code: branchOnly ? 'SANDBOX_CONTROL_BRANCH_ONLY' : 'SANDBOX_WORKSPACE_IDENTITY_CONFLICT',
      message: branchOnly
        ? `Container is branch-only but the requested sandbox is ${expectedIdentity}.`
        : `Container identity ${actualIdentity} on branch ${snapshot.actualBranch ?? 'unknown'} does not match requested ${expectedIdentity} on branch ${snapshot.expectedBranch}.`
    });
  }
  if (snapshot.runtimeCapabilityOk === false) {
    findings.push({
      repairKind: 'hard-failure',
      message: 'Container runtime capability signature does not match the current sandbox plan.'
    });
  }
  for (const mountPath of snapshot.unexpectedCapabilityMounts ?? []) {
    findings.push({
      repairKind: 'hard-failure',
      message: `Disabled Agent Client capability remains mounted at ${mountPath}.`,
      path: mountPath
    });
  }

  for (const mount of snapshot.mounts) {
    if (
      mount.actualType !== mount.expectedType
      || !mount.sourceMatches
      || mount.actualRW !== mount.expectedRW
      || !mount.sourceAccessible
    ) {
      findings.push({
        repairKind: 'hard-failure',
        message: `Expected ${mount.expectedType} mount at ${mount.path}`
          + `${mount.expectedSource === null ? '' : ` from ${mount.expectedSource}`}`
          + ` with RW=${mount.expectedRW}, found ${mount.actualType ?? 'none'}`
          + `${mount.actualSource === null ? '' : ` from ${mount.actualSource}`}`
          + ` with RW=${mount.actualRW ?? 'unknown'}.`,
        path: mount.path
      });
    }
  }

  for (const mount of snapshot.tmpfs) {
    if (!mount.permissionsOk || !mount.writable) {
      findings.push({
        repairKind: 'permissions',
        message: `Tmpfs ${mount.path} is not owned and writable by devuser with mode 0700.`,
        path: mount.path
      });
    }
  }

  for (const seed of snapshot.seeds) {
    if (!seed.mounted) {
      continue;
    }
    if (seed.targetState === 'missing' || seed.targetState === 'wrong-type') {
      findings.push({
        repairKind: 'missing-seed',
        message: `Runtime seed target ${seed.targetPath} must be restored from staging.`,
        path: seed.targetPath,
        seed: {
          toolId: seed.toolId,
          containerMount: seed.containerMount ?? seed.targetPath.slice(0, seed.targetPath.lastIndexOf('/')),
          stagingPath: seed.stagingPath,
          targetPath: seed.targetPath
        }
      });
    } else if (seed.targetState === 'inaccessible') {
      findings.push({
        repairKind: 'hard-failure',
        message: `Runtime seed target ${seed.targetPath} exists but is not accessible to devuser.`,
        path: seed.targetPath
      });
    }
  }

  if (!snapshot.aliasesReadable) {
    findings.push({
      repairKind: 'hard-failure',
      message: 'Sandbox shell aliases are not readable by devuser.',
      path: '/home/devuser/.bash_aliases'
    });
  }

  for (const check of snapshot.agentClientChecks) {
    if (check.applicable && !check.healthy) {
      findings.push({
        ...check.finding,
        ...(check.repair === undefined ? {} : { repair: check.repair })
      });
    }
  }

  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = findingKey(finding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inspectContainer(
  engine: string,
  container: string,
  runFn: typeof runEngine
): DockerInspection {
  const raw = runFn(engine, 'docker', ['inspect', container]);
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0] !== 'object') {
    throw new Error(`Unable to inspect sandbox container '${container}'.`);
  }
  return parsed[0] as DockerInspection;
}

function probe(
  engine: string,
  container: string,
  script: string,
  args: string[],
  runOkFn: typeof runOkEngine,
  user = 'devuser'
): boolean {
  return runOkFn(engine, 'docker', [
    'exec', '--user', user, container, 'sh', '-c', script, 'agent-infra-recovery', ...args
  ]);
}

function normalizeMountSource(engine: string, source: string): string {
  const normalized = toEnginePath(engine, source).replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized)
    ? `${normalized[0]!.toLowerCase()}${normalized.slice(1)}`
    : normalized;
}

function sourceCandidates(engine: string, hostPath: string): string[] {
  const candidates = [hostPath];
  try {
    candidates.push(fs.realpathSync(hostPath));
  } catch {
    // The access check below reports a missing or inaccessible host source.
  }
  return [...new Set(candidates.map((candidate) => normalizeMountSource(engine, candidate)))];
}

function sameHostSource(left: string, right: string): boolean {
  try {
    const leftStat = fs.statSync(left, { bigint: true });
    const rightStat = fs.statSync(right, { bigint: true });
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function hostSourceAccessible(hostPath: string, writable: boolean): boolean {
  try {
    fs.accessSync(
      hostPath,
      fs.constants.R_OK | (writable ? fs.constants.W_OK : 0)
    );
    return true;
  } catch {
    return false;
  }
}

function expectedMounts(params: {
  config: SandboxConfig;
  branch: string;
  container: string;
  workspace: SandboxWorkspaceIdentity;
  tools: readonly SandboxTool[];
  actualMounts: Map<string, DockerMount>;
}): ExpectedMount[] {
  const { config, branch, tools, actualMounts } = params;
  const view = sandboxWorkspaceViewPaths({
    base: config.workspaceViewBase ?? path.join(config.home, '.agent-infra', 'workspace-views'),
    project: config.project,
    container: params.container,
    identity: params.workspace
  });
  const control = sandboxControlPaths({
    base: config.controlBase ?? path.join(config.home, '.agent-infra', 'sandbox-control'),
    project: config.project,
    container: params.container,
    identity: params.workspace
  });
  const core = sandboxCoreBindMounts(config, branch, {
    workspaceViewRoot: view.root,
    controlDir: control.channelDir,
    controlStatusDir: control.statusDir,
    ...(params.workspace.mode === 'task-bound'
      ? {
        taskSource: assertSandboxTaskSource(config.repoRoot, params.workspace.taskId),
        taskId: params.workspace.taskId
      }
      : {})
  }).map((mount) => ({
    path: mount.containerPath,
    expectedType: 'bind' as const,
    hostPaths: mount.hostPaths,
    expectedRW: !mount.readOnly
  }));
  const live = tools.flatMap((tool) =>
    (tool.hostLiveMounts ?? []).flatMap(({ hostPath, containerSubpath }) => {
      const destination = path.posix.join(tool.containerMount, containerSubpath);
      if (!fs.existsSync(hostPath) && !actualMounts.has(destination)) return [];
      return [{
        path: destination,
        expectedType: 'bind' as const,
        hostPaths: [hostPath],
        expectedRW: true
      }];
    })
  );
  const persistentTools = tools
    .filter((tool) =>
      !tool.tmpfs
      && (
        config.agentClientSource === 'canonical'
        || actualMounts.has(tool.containerMount)
      )
    )
    .map((tool) => ({
      path: tool.containerMount,
      expectedType: 'bind' as const,
      hostPaths: toolConfigDirCandidates(tool, config.project, branch),
      expectedRW: true
    }));
  const staging = tools.flatMap((tool) =>
    (tool.tmpfs?.seed ?? []).flatMap((seedEntry, index) => {
      const stagingPath = `/run/agent-infra/tmpfs-seeds/${tool.id}/${index}`;
      if (!actualMounts.has(stagingPath)) return [];
      return [{
        path: stagingPath,
        expectedType: 'bind' as const,
        hostPaths: toolConfigDirCandidates(tool, config.project, branch)
          .map((candidate) => path.join(candidate, seedEntry)),
        expectedRW: false
      }];
    })
  );
  return [
    ...core,
    ...persistentTools,
    ...live,
    ...staging,
    ...tools
      .filter((tool) => tool.tmpfs)
      .map((tool) => ({
        path: tool.containerMount,
        expectedType: 'tmpfs' as const,
        hostPaths: [],
        expectedRW: true
      }))
  ];
}

function targetState(
  engine: string,
  container: string,
  seed: TmpfsSeedEntry,
  runOkFn: typeof runOkEngine
): SandboxRecoverySnapshot['seeds'][number]['targetState'] {
  const exists = probe(
    engine,
    container,
    'test -e "$1" || test -L "$1"',
    [seed.targetPath],
    runOkFn
  );
  if (!exists) return 'missing';

  const compatible = probe(
    engine,
    container,
    'if test -d "$1"; then test -d "$2"; else test -f "$2"; fi',
    [seed.stagingPath, seed.targetPath],
    runOkFn
  );
  if (!compatible) return 'wrong-type';

  const readable = runOkFn(engine, 'docker', [
    'exec', '--user', 'devuser', container, 'test', '-r', seed.targetPath
  ]);
  const writable = runOkFn(engine, 'docker', [
    'exec', '--user', 'devuser', container, 'test', '-w', seed.targetPath
  ]);
  return readable && writable ? 'ok' : 'inaccessible';
}

export function collectSandboxRecoverySnapshot(params: {
  config: SandboxConfig;
  engine: string;
  branch: string;
  workspace?: SandboxWorkspaceIdentity;
  container: string;
  deps?: RecoveryCommandDeps;
}): SandboxRecoverySnapshot {
  const runFn = params.deps?.run ?? runEngine;
  const runOkFn = params.deps?.runOk ?? runOkEngine;
  const inspection = inspectContainer(params.engine, params.container, runFn);
  const mounts = Array.isArray(inspection.Mounts) ? inspection.Mounts : [];
  const mountsByDestination = new Map(
    mounts.flatMap((mount) =>
      typeof mount.Destination === 'string'
        ? [[mount.Destination, mount] as const]
        : []
    )
  );
  const declaredTmpfs = inspection.HostConfig?.Tmpfs;
  if (declaredTmpfs && typeof declaredTmpfs === 'object' && !Array.isArray(declaredTmpfs)) {
    for (const [destination, rawOptions] of Object.entries(declaredTmpfs)) {
      if (mountsByDestination.has(destination) || typeof rawOptions !== 'string') continue;
      const options = rawOptions.split(',').map((option) => option.trim());
      mountsByDestination.set(destination, {
        Type: 'tmpfs',
        Source: '',
        Destination: destination,
        RW: !options.includes('ro')
      });
    }
  }
  const capabilityPlan = createSandboxCapabilityPlan(params.config);
  const workspace = params.workspace ?? { mode: 'branch-only' as const };
  const tools = [...capabilityPlan.tools];
  const seeds = declaredTmpfsSeedEntries(tools).map((seed) => {
    const mounted = mountsByDestination.get(seed.stagingPath)?.Type === 'bind';
    return {
      toolId: seed.toolId,
      containerMount: seed.containerMount,
      stagingPath: seed.stagingPath,
      targetPath: seed.targetPath,
      mounted,
      targetState: mounted
        ? targetState(params.engine, params.container, seed, runOkFn)
        : 'missing' as const
    };
  });
  const tmpfs = tools.filter((tool) => tool.tmpfs).map((tool) => ({
    path: tool.containerMount,
    permissionsOk: probe(
      params.engine,
      params.container,
      'test "$(stat -c %u:%g:%a -- "$1")" = "$(id -u devuser):$(id -g devuser):700"',
      [tool.containerMount],
      runOkFn
    ),
    writable: probe(
      params.engine,
      params.container,
      'probe="$1/.agent-infra-ready-$$"; trap \'rm -f -- "$probe"\' EXIT; : > "$probe"',
      [tool.containerMount],
      runOkFn
    )
  }));
  const labels = inspection.Config?.Labels ?? {};
  const branchLabel = labels[sandboxBranchLabel(params.config)];
  const containerWorkspace = parseSandboxWorkspaceIdentity(labels, {
    mode: sandboxWorkspaceModeLabel(params.config),
    taskId: sandboxTaskIdLabel(params.config)
  });
  const selectedToolIds = new Set(tools.map((tool) => tool.id));
  const enforceCanonicalPlan = params.config.agentClientSource === 'canonical';
  const unexpectedCapabilityMounts = enforceCanonicalPlan
    ? capabilityPlan.cleanupInventory
      .filter((tool) => isAgentClientId(tool.id) && !selectedToolIds.has(tool.id))
      .map((tool) => tool.containerMount)
      .filter((mountPath) => mountsByDestination.has(mountPath))
    : [];
  const mountSnapshots = expectedMounts({
    config: params.config,
    branch: params.branch,
    container: params.container,
    workspace,
    tools,
    actualMounts: mountsByDestination
  }).map((expected) => {
    const actual = mountsByDestination.get(expected.path);
    const actualSource = typeof actual?.Source === 'string' ? actual.Source : null;
    const actualSourceCandidates = actualSource === null
      ? []
      : sourceCandidates(params.engine, actualSource);
    const matchedHostPath = expected.hostPaths.find((hostPath) =>
      sourceCandidates(params.engine, hostPath).some((candidate) =>
        actualSourceCandidates.includes(candidate)
      )
      || (actualSource !== null && sameHostSource(hostPath, actualSource))
    );
    const sourceMatches = expected.expectedType === 'tmpfs'
      ? actualSource === '' || actualSource === null
      : matchedHostPath !== undefined;

    return {
      path: expected.path,
      expectedType: expected.expectedType,
      actualType: typeof actual?.Type === 'string' ? actual.Type : null,
      expectedSource: expected.hostPaths[0]
        ? normalizeMountSource(params.engine, expected.hostPaths[0])
        : null,
      actualSource,
      sourceMatches,
      expectedRW: expected.expectedRW,
      actualRW: typeof actual?.RW === 'boolean' ? actual.RW : null,
      sourceAccessible: expected.expectedType === 'tmpfs'
        ? true
        : matchedHostPath !== undefined
          && hostSourceAccessible(matchedHostPath, expected.expectedRW)
    };
  });

  return {
    containerIdValid: typeof inspection.Id === 'string' && inspection.Id.length > 0,
    expectedBranch: params.branch,
    actualBranch: typeof branchLabel === 'string' ? branchLabel : null,
    expectedWorkspace: workspace,
    actualWorkspace: containerWorkspace,
    identityOk: typeof inspection.Id === 'string' && inspection.Id.length > 0
      && branchLabel === params.branch
      && sameSandboxWorkspaceIdentity(containerWorkspace, workspace),
    runtimeCapabilityOk: enforceCanonicalPlan
      ? labels[sandboxRuntimeCapabilityLabel(params.config)] === capabilityPlan.runtimeSignature
      : undefined,
    unexpectedCapabilityMounts,
    mounts: mountSnapshots,
    tmpfs,
    seeds,
    aliasesReadable: probe(
      params.engine,
      params.container,
      'test -r "$1"',
      ['/home/devuser/.bash_aliases'],
      runOkFn
    ),
    agentClientChecks: capabilityPlan.recoveryChecks.map(({ adapterId, check }) => {
      const applicable = check.when === undefined || probe(
        params.engine,
        params.container,
        check.when.script,
        [...check.when.args],
        runOkFn,
        check.when.user
      );
      return {
        adapterId,
        checkId: check.id,
        applicable,
        healthy: !applicable || probe(
          params.engine,
          params.container,
          check.probe.script,
          [...check.probe.args],
          runOkFn,
          check.probe.user
        ),
        finding: check.finding,
        ...(check.repair === undefined ? {} : { repair: check.repair })
      };
    })
  };
}

export function prepareTmpfsMounts(params: {
  engine: string;
  container: string;
  mountPaths: string[];
  deps?: RecoveryCommandDeps;
}): void {
  const runVerboseFn = params.deps?.runVerbose ?? runVerboseEngine;
  for (const mountPath of params.mountPaths) {
    runVerboseFn(params.engine, 'docker', [
      'exec', '--user', 'root', params.container, 'chown', 'devuser:', '--', mountPath
    ]);
    runVerboseFn(params.engine, 'docker', [
      'exec', '--user', 'root', params.container, 'chmod', '0700', '--', mountPath
    ]);
  }
}

export function hydrateTmpfsSeedEntries(params: {
  engine: string;
  container: string;
  entries: TmpfsSeedEntry[];
  replace: boolean;
  deps?: RecoveryCommandDeps;
}): void {
  const runVerboseFn = params.deps?.runVerbose ?? runVerboseEngine;
  for (const entry of params.entries) {
    if (params.replace) {
      runVerboseFn(params.engine, 'docker', [
        'exec', '--user', 'devuser', params.container, 'rm', '-rf', '--', entry.targetPath
      ]);
    }
    runVerboseFn(params.engine, 'docker', [
      'exec', '--user', 'devuser', params.container, 'mkdir', '-p',
      entry.targetPath.slice(0, entry.targetPath.lastIndexOf('/'))
    ]);
    runVerboseFn(params.engine, 'docker', [
      'exec', '--user', 'devuser', params.container, 'cp', '-R', '--',
      entry.stagingPath, entry.targetPath
    ]);
  }
  validateTmpfsSeedEntries(params);
}

export function validateTmpfsSeedEntries(params: {
  engine: string;
  container: string;
  entries: TmpfsSeedEntry[];
  deps?: RecoveryCommandDeps;
}): void {
  const runVerboseFn = params.deps?.runVerbose ?? runVerboseEngine;
  const runOkFn = params.deps?.runOk ?? runOkEngine;
  for (const entry of params.entries) {
    runVerboseFn(params.engine, 'docker', [
      'exec', '--user', 'devuser', params.container, 'diff', '-qr', '--',
      entry.stagingPath, entry.targetPath
    ]);
    const readable = runOkFn(params.engine, 'docker', [
      'exec', '--user', 'devuser', params.container, 'test', '-r', entry.targetPath
    ]);
    const writable = runOkFn(params.engine, 'docker', [
      'exec', '--user', 'devuser', params.container, 'test', '-w', entry.targetPath
    ]);
    if (!readable || !writable) {
      throw new Error(`Hydrated seed target ${entry.targetPath} is not writable by devuser.`);
    }
  }
}

function mountedSeeds(snapshot: SandboxRecoverySnapshot): TmpfsSeedEntry[] {
  return snapshot.seeds.filter((seed) => seed.mounted).map((seed) => ({
    toolId: seed.toolId,
    containerMount: seed.containerMount ?? seed.targetPath.slice(0, seed.targetPath.lastIndexOf('/')),
    stagingPath: seed.stagingPath,
    targetPath: seed.targetPath
  }));
}

function repairFindings(params: {
  engine: string;
  container: string;
  findings: SandboxRecoveryFinding[];
  deps?: RecoveryCommandDeps;
}): void {
  const permissionPaths = params.findings
    .filter((finding) => finding.repairKind === 'permissions' && finding.path)
    .map((finding) => finding.path!);
  prepareTmpfsMounts({
    engine: params.engine,
    container: params.container,
    mountPaths: [...new Set(permissionPaths)],
    deps: params.deps
  });
  const missingSeeds = params.findings.flatMap((finding) =>
    finding.repairKind === 'missing-seed' && finding.seed ? [finding.seed] : []
  );
  hydrateTmpfsSeedEntries({
    engine: params.engine,
    container: params.container,
    entries: missingSeeds,
    replace: true,
    deps: params.deps
  });
  const runVerboseFn = params.deps?.runVerbose ?? runVerboseEngine;
  for (const repair of params.findings.flatMap((finding) =>
    finding.repair === undefined ? [] : [finding.repair]
  )) {
    runVerboseFn(params.engine, 'docker', [
      'exec', '--user', repair.user, params.container, repair.command, ...repair.args
    ]);
  }
}

function describeFindings(findings: SandboxRecoveryFinding[]): string {
  return findings.map((finding) => finding.code ? `${finding.code}: ${finding.message}` : finding.message).join(' ');
}

function assess(params: {
  config: SandboxConfig;
  engine: string;
  branch: string;
  workspace?: SandboxWorkspaceIdentity;
  container: string;
  deps?: RecoveryCommandDeps;
}): { snapshot: SandboxRecoverySnapshot; findings: SandboxRecoveryFinding[] } {
  const snapshot = collectSandboxRecoverySnapshot(params);
  return { snapshot, findings: classifySandboxRecovery(snapshot) };
}

function canRetryFreshReadiness(findings: SandboxRecoveryFinding[]): boolean {
  return findings.length > 0 && findings.every((finding) =>
    finding.repairKind === 'hard-failure'
    && finding.path !== undefined
    && (
      finding.path.startsWith('/workspace/.agents/workspace')
      || finding.path === '/home/devuser/.host-shell-config'
      || finding.path === '/home/devuser/.bash_aliases'
    )
  );
}

export async function assertFreshSandboxReady(params: {
  config: SandboxConfig;
  engine: string;
  branch: string;
  workspace?: SandboxWorkspaceIdentity;
  container: string;
  copiedEntries: TmpfsSeedEntry[];
  deps?: RecoveryCommandDeps;
}): Promise<void> {
  validateTmpfsSeedEntries({
    engine: params.engine,
    container: params.container,
    entries: params.copiedEntries,
    deps: params.deps
  });
  let { findings } = assess(params);
  if (canRetryFreshReadiness(findings)) {
    const runVerboseFn = params.deps?.runVerbose ?? runVerboseEngine;
    runVerboseFn(params.engine, 'docker', ['restart', params.container]);
    prepareTmpfsMounts({
      engine: params.engine,
      container: params.container,
      mountPaths: resolveTools(params.config)
        .filter((tool) => tool.tmpfs)
        .map((tool) => tool.containerMount),
      deps: params.deps
    });
    hydrateTmpfsSeedEntries({
      engine: params.engine,
      container: params.container,
      entries: params.copiedEntries,
      replace: true,
      deps: params.deps
    });
    let retried = assess(params);
    if (!retried.findings.some((finding) => finding.repairKind === 'hard-failure')) {
      repairFindings({
        engine: params.engine,
        container: params.container,
        findings: retried.findings,
        deps: params.deps
      });
      retried = assess(params);
    }
    findings = retried.findings;
  }
  if (findings.length > 0) {
    throw new Error(`Fresh sandbox readiness check failed: ${describeFindings(findings)}`);
  }
}

export async function ensureSandboxReady(params: EnsureSandboxReadyParams): Promise<SandboxReadyResult> {
  const deps = params.deps;
  const startFn = deps?.start ?? startSandboxContainer;
  const warnings: string[] = [];
  let failure: Error | null = null;
  try {
    if (deps?.ensureControlBroker) {
      await deps.ensureControlBroker();
    } else {
      await ensureSandboxControlBroker({
        config: params.config,
        container: params.row.name,
        workspace: params.workspace ?? { mode: 'branch-only' }
      });
    }
    if (!params.row.running) {
      startFn(params.engine, params.row.name);
      const initial = assess({
        config: params.config,
        engine: params.engine,
        branch: params.branch,
        workspace: params.workspace,
        container: params.row.name,
        deps
      });
      if (initial.findings.some((finding) => finding.repairKind === 'hard-failure')) {
        throw new Error(describeFindings(
          initial.findings.filter((finding) => finding.repairKind === 'hard-failure')
        ));
      }
      const tools = resolveTools(params.config);
      prepareTmpfsMounts({
        engine: params.engine,
        container: params.row.name,
        mountPaths: tools.filter((tool) => tool.tmpfs).map((tool) => tool.containerMount),
        deps
      });
      hydrateTmpfsSeedEntries({
        engine: params.engine,
        container: params.row.name,
        entries: mountedSeeds(initial.snapshot),
        replace: true,
        deps
      });
      let final = assess({
        config: params.config,
        engine: params.engine,
        branch: params.branch,
        workspace: params.workspace,
        container: params.row.name,
        deps
      });
      if (!final.findings.some((finding) => finding.repairKind === 'hard-failure')) {
        repairFindings({
          engine: params.engine,
          container: params.row.name,
          findings: final.findings,
          deps
        });
        final = assess({
          config: params.config,
          engine: params.engine,
          branch: params.branch,
          workspace: params.workspace,
          container: params.row.name,
          deps
        });
      }
      if (final.findings.length > 0) {
        throw new Error(describeFindings(final.findings));
      }
      return { container: params.row.name, path: 'recovered', warnings };
    }

    const initial = assess({
      config: params.config,
      engine: params.engine,
      branch: params.branch,
      workspace: params.workspace,
      container: params.row.name,
      deps
    });
    if (initial.findings.length === 0) {
      return { container: params.row.name, path: 'healthy', warnings };
    }
    if (initial.findings.some((finding) => finding.repairKind === 'hard-failure')) {
      throw new Error(describeFindings(initial.findings));
    }
    let current = initial;
    const permissionFindings = current.findings.filter(
      (finding) => finding.repairKind === 'permissions'
    );
    if (permissionFindings.length > 0) {
      repairFindings({
        engine: params.engine,
        container: params.row.name,
        findings: permissionFindings,
        deps
      });
      current = assess({
        config: params.config,
        engine: params.engine,
        branch: params.branch,
        workspace: params.workspace,
        container: params.row.name,
        deps
      });
      if (current.findings.some(
        (finding) => finding.repairKind === 'hard-failure'
          || finding.repairKind === 'permissions'
      )) {
        throw new Error(describeFindings(current.findings));
      }
    }
    repairFindings({
      engine: params.engine,
      container: params.row.name,
      findings: current.findings,
      deps
    });
    const final = assess({
      config: params.config,
      engine: params.engine,
      branch: params.branch,
      workspace: params.workspace,
      container: params.row.name,
      deps
    });
    if (final.findings.length > 0) {
      throw new Error(describeFindings(final.findings));
    }
    return { container: params.row.name, path: 'recovered', warnings };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const dataBoundary =
    'The existing container writable layer, ordinary /tmp data, processes, tmux sessions, and RAM state may be lost by replacement; worktree and host-managed sandbox data are preserved.';
  const recoveryTarget = params.workspace?.mode === 'task-bound'
    ? params.workspace.taskId
    : params.branch;
  if (!params.allowRecreate || !params.recreate) {
    throw new Error([
      `Sandbox recovery failed. Run 'ai sandbox start --recreate ${recoveryTarget}' on the host to authorize container-only replacement.`,
      dataBoundary,
      `Details: ${failure.message}`
    ].join('\n'));
  }

  const existingWorktrees = worktreeDirCandidates(params.config, params.branch).filter((candidate) => fs.existsSync(candidate));
  if (existingWorktrees.length !== 1) {
    const remediation = existingWorktrees.length === 0
      ? `Restore the worktree for '${params.branch}' before recovering the container.`
      : `Found ${existingWorktrees.map((candidate) => JSON.stringify(candidate)).join(', ')}; `
        + 'keep the worktree in use, remove the stale directory, then retry.';
    throw new Error(
      `SANDBOX_RECOVERY_WORKTREE_SNAPSHOT_INVALID: expected exactly one existing worktree for '${params.branch}', found ${existingWorktrees.length}. ${remediation}`
    );
  }
  const beforeInspection = inspectWorktree(existingWorktrees[0]!);
  if (beforeInspection.status === 'failed') {
    throw new Error(`SANDBOX_RECOVERY_WORKTREE_SNAPSHOT_INVALID: ${beforeInspection.message}`);
  }
  const before: WorktreeSnapshot = beforeInspection.snapshot;
  if (before.branch !== params.branch) {
    throw new Error(
      `SANDBOX_RECOVERY_WORKTREE_SNAPSHOT_INVALID: expected branch '${params.branch}', found '${before.branch}'. `
      + `Run 'git -C ${JSON.stringify(before.worktree)} checkout ${params.branch}' to restore the expected branch, then retry.`
    );
  }

  const warning = `Sandbox recovery failed in place. Replacing only the container. ${dataBoundary}`;
  warnings.push(warning);
  (params.writeWarning ?? ((message) => process.stderr.write(`${message}\n`)))(warning);
  const runVerboseFn = deps?.runVerbose ?? runVerboseEngine;
  let replacementResult: SandboxReadyResult | null = null;
  let replacementFailure: unknown = null;
  try {
    if (params.row.running) {
      runVerboseFn(params.engine, 'docker', ['stop', params.row.name]);
    }
    runVerboseFn(params.engine, 'docker', ['rm', params.row.name]);
    await params.recreate(params.branch);

    const rows = (deps?.fetchRows ?? fetchSandboxRows)(
      params.engine,
      sandboxLabel(params.config),
      sandboxBranchLabel(params.config)
    );
    const replacement = selectSandboxContainer(
      [...rows.running, ...rows.nonRunning],
      containerNameCandidates(params.config, params.branch)
    );
    if (!replacement?.running) {
      throw new Error('Replacement sandbox container was not found in a running state.');
    }
    const final = assess({
      config: params.config,
      engine: params.engine,
      branch: params.branch,
      workspace: params.workspace,
      container: replacement.name,
      deps
    });
    if (final.findings.length > 0) {
      throw new Error(`Replacement sandbox readiness check failed: ${describeFindings(final.findings)}`);
    }
    replacementResult = { container: replacement.name, path: 'recreated', warnings };
  } catch (error) {
    replacementFailure = error;
  }

  const afterInspection = inspectWorktree(before.worktree);
  if (afterInspection.status === 'failed' || afterInspection.snapshot.identity !== before.identity) {
    const detail = afterInspection.status === 'failed'
      ? afterInspection.message
      : `snapshot changed from ${before.identity} to ${afterInspection.snapshot.identity}`;
    throw new Error(`SANDBOX_RECOVERY_WORKTREE_CHANGED: ${detail}`, replacementFailure === null ? undefined : { cause: replacementFailure });
  }
  if (replacementFailure !== null) throw replacementFailure;
  return replacementResult!;
}
