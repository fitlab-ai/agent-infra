type SandboxToolInstall =
  | Readonly<{ type: 'npm'; cmd: string }>
  | Readonly<{ type: 'shell'; cmd: string }>;

type SandboxTool = {
  id: string;
  name: string;
  install: SandboxToolInstall;
  sandboxBase: string;
  containerMount: string;
  versionCmd: string;
  setupHint: string;
  envVars?: Record<string, string>;
  hostPreSeedFiles?: Array<{ hostPath: string; sandboxName: string }>;
  hostPreSeedDirs?: Array<{ hostDir: string; sandboxSubdir: string }>;
  pathRewriteFiles?: string[];
  hostLiveMounts?: Array<{ hostPath: string; containerSubpath: string }>;
  postSetupCmds?: string[];
  tmpfs?: { size?: string; seed?: string[] };
};

type SandboxAlias = Readonly<{
  name: string;
  command: string;
}>;

const SANDBOX_HOOK_PHASES = [
  'prepare',
  'before-container-create',
  'after-container-start',
  'before-enter'
] as const;

type SandboxHookPhase = (typeof SANDBOX_HOOK_PHASES)[number];

type SandboxHookStatus =
  | 'ready'
  | 'skip-client-runtime'
  | 'warning'
  | 'fatal'
  | 'healthy'
  | 'hard-failure';

type SandboxHookCommand = Readonly<{
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}>;

type SandboxHookCommandResult = Readonly<{
  stdout: string;
}>;

type AgentClientSandboxHookResult = Readonly<{
  status: SandboxHookStatus;
  message?: string;
}>;

type SandboxResolvedToolState = Readonly<{
  tool: SandboxTool;
  dir: string;
}>;

type SandboxHookCreateContext = Readonly<{
  hostHome: string;
  hostEnv?: Readonly<NodeJS.ProcessEnv>;
  resolvedTools: readonly SandboxResolvedToolState[];
}>;

type AgentClientSandboxHookContext = Readonly<{
  signal: AbortSignal;
  runCommand(command: SandboxHookCommand): Promise<SandboxHookCommandResult>;
  config?: Readonly<Record<string, unknown>>;
  plan?: Readonly<Record<string, unknown>>;
  create?: SandboxHookCreateContext;
}>;

type AgentClientSandboxHook = Readonly<{
  id: string;
  phase: SandboxHookPhase;
  timeoutMs?: number;
  run(context: AgentClientSandboxHookContext): Promise<AgentClientSandboxHookResult>;
}>;

type SandboxToolContext = Readonly<{
  home: string;
  project: string;
}>;

type SandboxRecoveryProbe = Readonly<{
  script: string;
  args: readonly string[];
  user?: string;
}>;

type SandboxRecoveryFindingDescriptor = Readonly<{
  repairKind: 'permissions' | 'builtin-link' | 'hard-failure';
  message: string;
  path?: string;
}>;

type SandboxRecoveryRepair = Readonly<{
  user: string;
  command: string;
  args: readonly string[];
}>;

type AgentClientSandboxRecoveryCheck = Readonly<{
  id: string;
  when?: SandboxRecoveryProbe;
  probe: SandboxRecoveryProbe;
  finding: SandboxRecoveryFindingDescriptor;
  repair?: SandboxRecoveryRepair;
}>;

type AgentClientSandboxDescriptor = Readonly<{
  createTool(context: SandboxToolContext): SandboxTool;
  aliases: readonly SandboxAlias[];
  hooks: readonly AgentClientSandboxHook[];
  recoveryChecks?: readonly AgentClientSandboxRecoveryCheck[];
}>;

export { SANDBOX_HOOK_PHASES };
export type {
  AgentClientSandboxDescriptor,
  AgentClientSandboxHook,
  AgentClientSandboxHookContext,
  AgentClientSandboxHookResult,
  AgentClientSandboxRecoveryCheck,
  SandboxAlias,
  SandboxHookCommand,
  SandboxHookCommandResult,
  SandboxHookPhase,
  SandboxHookStatus,
  SandboxHookCreateContext,
  SandboxRecoveryFindingDescriptor,
  SandboxRecoveryProbe,
  SandboxRecoveryRepair,
  SandboxResolvedToolState,
  SandboxTool,
  SandboxToolContext,
  SandboxToolInstall
};
