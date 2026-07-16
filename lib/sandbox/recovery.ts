import fs from 'node:fs';
import path from 'node:path';
import { containerNameCandidates, sandboxBranchLabel, sandboxLabel } from './constants.ts';
import type { SandboxConfig } from './config.ts';
import { toEnginePath } from './engines/wsl2-paths.ts';
import { sandboxCoreBindMounts } from './mounts.ts';
import { runEngine, runOkEngine, runVerboseEngine } from './shell.ts';
import {
  declaredTmpfsSeedEntries,
  resolveTools,
  toolConfigDirCandidates,
  type TmpfsSeedEntry
} from './tools.ts';
import {
  fetchSandboxRows,
  selectSandboxContainer,
  startSandboxContainer,
  type SandboxRow
} from './commands/list-running.ts';

export type SandboxRecoveryFinding = {
  repairKind: 'permissions' | 'missing-seed' | 'builtin-link' | 'hard-failure';
  message: string;
  path?: string;
  seed?: TmpfsSeedEntry;
};

export type SandboxRecoverySnapshot = {
  identityOk: boolean;
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
  codex?: {
    commandAvailable: boolean;
    stateWritable: boolean;
    promptsSourceExists: boolean;
    promptsValid: boolean;
  };
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
  Mounts?: DockerMount[];
};

type RecoveryCommandDeps = {
  run?: typeof runEngine;
  runOk?: typeof runOkEngine;
  runVerbose?: typeof runVerboseEngine;
  start?: typeof startSandboxContainer;
  fetchRows?: typeof fetchSandboxRows;
};

type EnsureSandboxReadyParams = {
  config: SandboxConfig;
  engine: string;
  branch: string;
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

function findingKey(finding: SandboxRecoveryFinding): string {
  return `${finding.repairKind}:${finding.path ?? finding.seed?.targetPath ?? finding.message}`;
}

export function classifySandboxRecovery(snapshot: SandboxRecoverySnapshot): SandboxRecoveryFinding[] {
  const findings: SandboxRecoveryFinding[] = [];
  if (!snapshot.identityOk) {
    findings.push({
      repairKind: 'hard-failure',
      message: 'Container identity does not match the requested sandbox branch.'
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

  if (snapshot.codex) {
    if (!snapshot.codex.commandAvailable) {
      findings.push({
        repairKind: 'hard-failure',
        message: 'Codex is not available on PATH inside the sandbox.'
      });
    }
    if (!snapshot.codex.stateWritable) {
      findings.push({
        repairKind: 'permissions',
        message: 'Codex state directory is not writable by devuser.',
        path: '/home/devuser/.codex'
      });
    }
    if (snapshot.codex.promptsSourceExists && !snapshot.codex.promptsValid) {
      findings.push({
        repairKind: 'builtin-link',
        message: 'Codex prompts link does not point to the workspace commands directory.',
        path: '/home/devuser/.codex/prompts'
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
  engine: string;
  actualMounts: Map<string, DockerMount>;
}): ExpectedMount[] {
  const { config, branch, actualMounts } = params;
  const tools = resolveTools(config);
  const core = sandboxCoreBindMounts(config, branch).map((mount) => ({
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
    .filter((tool) => !tool.tmpfs && actualMounts.has(tool.containerMount))
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

  return probe(
    engine,
    container,
    'test -r "$1" && test -w "$1"',
    [seed.targetPath],
    runOkFn
  ) ? 'ok' : 'inaccessible';
}

export function collectSandboxRecoverySnapshot(params: {
  config: SandboxConfig;
  engine: string;
  branch: string;
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
  const tools = resolveTools(params.config);
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
      'test "$(stat -c %U:%G:%a -- "$1")" = devuser:devuser:700',
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
  const hasCodex = tools.some((tool) => tool.id === 'codex');
  const mountSnapshots = expectedMounts({
    config: params.config,
    branch: params.branch,
    engine: params.engine,
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
    identityOk: typeof inspection.Id === 'string'
      && inspection.Id.length > 0
      && branchLabel === params.branch,
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
    codex: hasCodex
      ? {
          commandAvailable: probe(
            params.engine,
            params.container,
            'command -v codex',
            [],
            runOkFn
          ),
          stateWritable: probe(
            params.engine,
            params.container,
            'probe="$1/.agent-infra-codex-state-$$"; trap \'rm -f -- "$probe"\' EXIT; : > "$probe"',
            ['/home/devuser/.codex'],
            runOkFn
          ),
          promptsSourceExists: probe(
            params.engine,
            params.container,
            'test -d "$1"',
            ['/workspace/.codex/commands'],
            runOkFn
          ),
          promptsValid: probe(
            params.engine,
            params.container,
            'test "$(readlink -- "$1")" = "$2"',
            ['/home/devuser/.codex/prompts', '/workspace/.codex/commands'],
            runOkFn
          )
        }
      : undefined
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
      'exec', '--user', 'root', params.container, 'chown', 'devuser:devuser', '--', mountPath
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
    if (!probe(
      params.engine,
      params.container,
      'test -r "$1" -a -w "$1"',
      [entry.targetPath],
      runOkFn
    )) {
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
  if (params.findings.some((finding) => finding.repairKind === 'builtin-link')) {
    runVerboseFn(params.engine, 'docker', [
      'exec', '--user', 'devuser', params.container, 'ln', '-sfn',
      '/workspace/.codex/commands', '/home/devuser/.codex/prompts'
    ]);
  }
}

function describeFindings(findings: SandboxRecoveryFinding[]): string {
  return findings.map((finding) => finding.message).join(' ');
}

function assess(params: {
  config: SandboxConfig;
  engine: string;
  branch: string;
  container: string;
  deps?: RecoveryCommandDeps;
}): { snapshot: SandboxRecoverySnapshot; findings: SandboxRecoveryFinding[] } {
  const snapshot = collectSandboxRecoverySnapshot(params);
  return { snapshot, findings: classifySandboxRecovery(snapshot) };
}

export function assertFreshSandboxReady(params: {
  config: SandboxConfig;
  engine: string;
  branch: string;
  container: string;
  copiedEntries: TmpfsSeedEntry[];
  deps?: RecoveryCommandDeps;
}): void {
  validateTmpfsSeedEntries({
    engine: params.engine,
    container: params.container,
    entries: params.copiedEntries,
    deps: params.deps
  });
  const { findings } = assess(params);
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
    if (!params.row.running) {
      startFn(params.engine, params.row.name);
      const initial = assess({
        config: params.config,
        engine: params.engine,
        branch: params.branch,
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
  if (!params.allowRecreate || !params.recreate) {
    throw new Error(`Sandbox recovery failed: ${failure.message} ${dataBoundary} Re-run with --recreate to authorize container-only replacement.`);
  }

  const warning = `Sandbox recovery failed in place. Replacing only the container. ${dataBoundary}`;
  warnings.push(warning);
  (params.writeWarning ?? ((message) => process.stderr.write(`${message}\n`)))(warning);
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
    container: replacement.name,
    deps
  });
  if (final.findings.length > 0) {
    throw new Error(`Replacement sandbox readiness check failed: ${describeFindings(final.findings)}`);
  }
  return { container: replacement.name, path: 'recreated', warnings };
}
