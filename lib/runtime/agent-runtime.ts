import path from 'node:path';

export type AgentRuntimeStore = 'capabilities' | 'lifecycle';

type RuntimeResolutionOptions = Readonly<{
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  explicitRoot?: string;
  client?: string;
  store?: AgentRuntimeStore;
}>;

const CLIENT_NAMESPACE = /^[a-z][a-z0-9-]{0,31}$/u;

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

function clientNamespace(client: string): string {
  if (!CLIENT_NAMESPACE.test(client)) {
    throw runtimeError('AGENT_INFRA_RUNTIME_CLIENT_INVALID', `invalid runtime client namespace '${client}'`);
  }
  return client;
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

export function resolveAgentRuntimeStoreRoot(options: RuntimeResolutionOptions = {}): string {
  const client = clientNamespace(options.client ?? 'codex');
  if (options.explicitRoot) return path.resolve(options.explicitRoot);
  const env = options.env ?? process.env;
  const runtimeRoot = resolveAgentRuntimeRoot({ repoRoot: options.repoRoot, env });
  if (env.AGENT_INFRA_RUNTIME_DIR) {
    if (!options.store) {
      throw runtimeError('AGENT_INFRA_RUNTIME_STORE_INVALID', 'store kind is required for task-bound runtime');
    }
    return path.join(runtimeRoot, 'clients', client, options.store);
  }
  if (client === 'codex' && options.store) {
    return path.join(runtimeRoot, `codex-${options.store}`);
  }
  if (!options.store) {
    throw runtimeError('AGENT_INFRA_RUNTIME_STORE_INVALID', 'store kind is required');
  }
  return path.join(runtimeRoot, 'clients', client, options.store);
}
