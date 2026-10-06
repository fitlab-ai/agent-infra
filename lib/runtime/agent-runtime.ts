import path from 'node:path';
import { resolveTaskRuntimeRoot } from '../task/runtime-paths.ts';

type RuntimeResolutionOptions = Readonly<{
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  taskId?: string;
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
  const taskId = env.AGENT_INFRA_TASK_ID;
  if (taskId) {
    return resolveTaskRuntimeRoot(taskId, { repoRoot: options.repoRoot });
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
  if (env.AGENT_INFRA_RUNTIME_DIR) {
    return path.join(resolveAgentRuntimeRoot({ repoRoot: options.repoRoot, env }), 'clients', 'codex', 'capabilities');
  }
  const taskId = options.taskId ?? env.AGENT_INFRA_TASK_ID;
  if (taskId) {
    return path.join(
      resolveTaskRuntimeRoot(taskId, { repoRoot: options.repoRoot }),
      'sandbox-control', 'runtime', 'clients', 'codex', 'capabilities'
    );
  }
  const runtimeRoot = resolveAgentRuntimeRoot({ repoRoot: options.repoRoot, env });
  return path.join(runtimeRoot, 'codex-capabilities');
}
