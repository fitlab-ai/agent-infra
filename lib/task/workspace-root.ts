import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { isSandbox } from '../sandbox/environment.ts';

export type ExecutionBoundary = 'host' | 'container';
export type SandboxMode = 'task-bound' | 'branch-only';

/**
 * Resolve the physical task-workspace boundary from the verified process
 * execution context. Sandbox mode (task-bound / branch-only) does not affect
 * the task workspace mount location.
 */
export function resolveTaskWorkspaceExecutionBoundary(
  env: NodeJS.ProcessEnv = process.env
): ExecutionBoundary {
  if (env.AGENT_INFRA_SANDBOX !== '1') return 'host';
  const statusMountPath = env.AGENT_INFRA_CONTROL_STATUS_DIR;
  if (!statusMountPath || !isSandbox(env, { statusMountPath })) {
    throw new Error('task workspace boundary requires a verified sandbox execution context');
  }
  return 'container';
}

export interface TaskWorkspaceLayout {
  projectKey: string;
  boundary: ExecutionBoundary;
  root: string;
  active: string;
  blocked: string;
  completed: string;
  archive: string;
  shortIds: string;
}

export function resolveTaskWorkspaceLayout(input: {
  project: string;
  boundary: ExecutionBoundary;
  home?: string;
}): TaskWorkspaceLayout {
  const { project, boundary } = input;
  if (!project || project === '.' || project === '..' || /[\\/\u0000-\u001f\u007f]/u.test(project)) {
    throw new TypeError('project must be a safe single path segment');
  }
  let root: string;
  if (boundary === 'container') {
    root = '/task-workspace';
  } else if (boundary === 'host') {
    if (!input.home) throw new TypeError('home is required for host task workspace resolution');
    if (!path.isAbsolute(input.home)) throw new TypeError('home must be an absolute path for host task workspace resolution');
    root = path.join(input.home, '.agent-infra', 'task-workspaces', project);
  } else {
    throw new TypeError(`unsupported task workspace boundary: ${String(boundary)}`);
  }
  return {
    projectKey: project,
    boundary,
    root,
    active: path.join(root, 'active'),
    blocked: path.join(root, 'blocked'),
    completed: path.join(root, 'completed'),
    archive: path.join(root, 'archive'),
    shortIds: path.join(root, 'active', '.short-ids.json')
  };
}

export function resolveProjectTaskWorkspaceLayout(
  repoRoot: string,
  boundary: ExecutionBoundary = resolveTaskWorkspaceExecutionBoundary()
): TaskWorkspaceLayout {
  const configPath = path.join(repoRoot, '.agents', '.airc.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { project?: unknown };
  if (typeof config.project !== 'string') throw new TypeError(`project is missing from ${configPath}`);
  return resolveTaskWorkspaceLayout({ project: config.project, boundary, home: process.env.HOME || os.homedir() });
}

export function resolveProjectTaskWorkspaceRoot(repoRoot: string): string {
  return resolveProjectTaskWorkspaceLayout(repoRoot).root;
}
