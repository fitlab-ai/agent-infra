import path from 'node:path';

type RuntimeResolutionOptions = Readonly<{
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
}>;

function runtimeError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  error.name = code;
  return error;
}

function boundControlContext(env: NodeJS.ProcessEnv): boolean {
  return [
    'AGENT_INFRA_CONTROL_TOKEN',
    'AGENT_INFRA_CONTROL_GENERATION',
    'AGENT_INFRA_EXECUTOR_MANIFEST',
    'AGENT_INFRA_CODEX_CONTROLLER_CONTEXT'
  ].some((key) => typeof env[key] === 'string' && env[key]!.length > 0);
}

export function resolveAgentRuntimeRoot(options: Readonly<{
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
}> = {}): string {
  const env = options.env ?? process.env;
  const configured = env.AGENT_INFRA_RUNTIME_DIR;
  if (configured !== undefined && configured.length > 0) {
    if (!path.isAbsolute(configured)) {
      throw runtimeError('AGENT_INFRA_RUNTIME_DIR_INVALID', 'runtime directory must be absolute');
    }
    return path.resolve(configured);
  }
  if (boundControlContext(env)) {
    throw runtimeError(
      'AGENT_INFRA_RUNTIME_DIR_REQUIRED',
      'task-bound control context requires AGENT_INFRA_RUNTIME_DIR'
    );
  }
  return path.join(path.resolve(options.repoRoot ?? process.cwd()), '.agents', 'workspace', '.runtime');
}

export function resolveAgentCapabilityStoreRoot(options: RuntimeResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const runtimeRoot = resolveAgentRuntimeRoot({ repoRoot: options.repoRoot, env });
  if (env.AGENT_INFRA_RUNTIME_DIR) {
    return path.join(runtimeRoot, 'clients', 'codex', 'capabilities');
  }
  return path.join(runtimeRoot, 'codex-capabilities');
}
