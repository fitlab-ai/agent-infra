import path from 'node:path';
import { createSandboxCapabilityPlan } from './agent-client-reconciler.ts';
import { safeNameCandidates, sanitizeBranchName } from './constants.ts';
import { hostJoin } from './engines/wsl2-paths.ts';
import type { SandboxTool, SandboxToolInstall } from './tool-types.ts';

export type { SandboxTool, SandboxToolInstall } from './tool-types.ts';

export type TmpfsSeedEntry = {
  toolId: string;
  containerMount: string;
  stagingPath: string;
  targetPath: string;
};

export function tmpfsSeedStagingPath(toolId: string, index: number): string {
  return `/run/agent-infra/tmpfs-seeds/${toolId}/${index}`;
}

export function tmpfsSeedTargetPath(containerMount: string, entry: string): string {
  const normalized = path.posix.normalize(entry);
  if (path.posix.isAbsolute(entry) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`tmpfs seed entry must stay within ${containerMount}: ${entry}`);
  }
  return path.posix.join(containerMount, normalized);
}

export function declaredTmpfsSeedEntries(tools: SandboxTool[]): TmpfsSeedEntry[] {
  return tools.flatMap((tool) =>
    (tool.tmpfs?.seed ?? []).map((entry, index) => ({
      toolId: tool.id,
      containerMount: tool.containerMount,
      stagingPath: tmpfsSeedStagingPath(tool.id, index),
      targetPath: tmpfsSeedTargetPath(tool.containerMount, entry)
    }))
  );
}

type ToolsConfig = {
  home: string;
  project: string;
  tools: string[];
  customTools?: SandboxTool[];
  agentClientState: import('../agent-clients/types.ts').AgentClientState;
};

const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function validateTool(tool: SandboxTool): void {
  if (!tool.id || !TOOL_ID_PATTERN.test(tool.id)) {
    throw new Error(`Invalid sandbox tool id: ${String(tool.id)}`);
  }
  if (!tool.install || (tool.install.type !== 'npm' && tool.install.type !== 'shell')) {
    throw new Error(`Sandbox tool ${tool.id} has invalid install.type`);
  }
  if (!tool.install.cmd) {
    throw new Error(`Sandbox tool ${tool.id} has empty install.cmd`);
  }
  if (!tool.containerMount || !tool.containerMount.startsWith('/')) {
    throw new Error(`Sandbox tool ${tool.id} containerMount must be an absolute path`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context}: field "${field}" must be a string`);
  }
  return value;
}

function asOptionalNonEmptyString(value: unknown, field: string, context: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${context}: field "${field}" must be a string when provided`);
  }
  if (value.length === 0) {
    throw new Error(`${context}: field "${field}" must be non-empty when provided`);
  }
  return value;
}

function asStringRecord(value: unknown, field: string, context: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error(`${context}: field "${field}" must be an object when provided`);
  }
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val !== 'string') {
      throw new Error(`${context}: field "${field}.${key}" must be a string`);
    }
    out[key] = val;
  }
  return out;
}

function asStringArray(value: unknown, field: string, context: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context}: field "${field}" must be an array when provided`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`${context}: field "${field}[${index}]" must be a string`);
    }
    return item;
  });
}

function parseInstall(value: unknown, context: string): SandboxToolInstall {
  if (!isPlainObject(value)) {
    throw new Error(`${context}: field "install" must be an object`);
  }
  const type = value.type;
  if (type !== 'npm' && type !== 'shell') {
    throw new Error(`${context}: field "install.type" must be "npm" or "shell"`);
  }
  const cmd = asString(value.cmd, 'install.cmd', context);
  if (!cmd) {
    throw new Error(`${context}: field "install.cmd" must be non-empty`);
  }
  return { type, cmd };
}

function parseHostPreSeedFiles(value: unknown, context: string): SandboxTool['hostPreSeedFiles'] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context}: field "hostPreSeedFiles" must be an array when provided`);
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`${context}: field "hostPreSeedFiles[${index}]" must be an object`);
    }
    return {
      hostPath: asString(item.hostPath, `hostPreSeedFiles[${index}].hostPath`, context),
      sandboxName: asString(item.sandboxName, `hostPreSeedFiles[${index}].sandboxName`, context)
    };
  });
}

function parseHostPreSeedDirs(value: unknown, context: string): SandboxTool['hostPreSeedDirs'] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context}: field "hostPreSeedDirs" must be an array when provided`);
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`${context}: field "hostPreSeedDirs[${index}]" must be an object`);
    }
    return {
      hostDir: asString(item.hostDir, `hostPreSeedDirs[${index}].hostDir`, context),
      sandboxSubdir: asString(item.sandboxSubdir, `hostPreSeedDirs[${index}].sandboxSubdir`, context)
    };
  });
}

function parseHostLiveMounts(value: unknown, context: string): SandboxTool['hostLiveMounts'] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context}: field "hostLiveMounts" must be an array when provided`);
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`${context}: field "hostLiveMounts[${index}]" must be an object`);
    }
    return {
      hostPath: asString(item.hostPath, `hostLiveMounts[${index}].hostPath`, context),
      containerSubpath: asString(item.containerSubpath, `hostLiveMounts[${index}].containerSubpath`, context)
    };
  });
}

function parseTmpfs(value: unknown, context: string): SandboxTool['tmpfs'] {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error(`${context}: field "tmpfs" must be an object when provided`);
  }
  return {
    size: asOptionalNonEmptyString(value.size, 'tmpfs.size', context),
    seed: asStringArray(value.seed, 'tmpfs.seed', context)
  };
}

export function parseCustomTool(
  entry: unknown,
  index: number,
  options: { home: string }
): SandboxTool {
  const context = `customTools[${index}]`;
  if (!isPlainObject(entry)) {
    throw new Error(`${context} must be an object`);
  }

  const id = asString(entry.id, 'id', context);
  if (!TOOL_ID_PATTERN.test(id)) {
    throw new Error(`${context}: field "id" must match ${TOOL_ID_PATTERN.source}`);
  }

  const containerMount = asOptionalNonEmptyString(entry.containerMount, 'containerMount', context)
    ?? `/home/devuser/.${id}`;
  if (!containerMount.startsWith('/')) {
    throw new Error(`${context}: field "containerMount" must be an absolute path`);
  }

  const tool: SandboxTool = {
    id,
    name: asOptionalNonEmptyString(entry.name, 'name', context) ?? id,
    install: parseInstall(entry.install, context),
    sandboxBase: hostJoin(options.home, '.agent-infra', 'sandboxes', id),
    containerMount,
    versionCmd: asOptionalNonEmptyString(entry.versionCmd, 'versionCmd', context) ?? `which ${id}`,
    setupHint: asOptionalNonEmptyString(entry.setupHint, 'setupHint', context)
      ?? `Run \`${id}\` inside the container to set up.`,
    envVars: asStringRecord(entry.envVars, 'envVars', context),
    hostPreSeedFiles: parseHostPreSeedFiles(entry.hostPreSeedFiles, context),
    hostPreSeedDirs: parseHostPreSeedDirs(entry.hostPreSeedDirs, context),
    pathRewriteFiles: asStringArray(entry.pathRewriteFiles, 'pathRewriteFiles', context),
    hostLiveMounts: parseHostLiveMounts(entry.hostLiveMounts, context),
    postSetupCmds: asStringArray(entry.postSetupCmds, 'postSetupCmds', context),
    tmpfs: parseTmpfs(entry.tmpfs, context)
  };

  validateTool(tool);
  return tool;
}

export function parseCustomTools(value: unknown, options: { home: string }): SandboxTool[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('sandbox: "customTools" must be an array');
  }
  return value.map((entry, index) => parseCustomTool(entry, index, options));
}

export function resolveTools(config: ToolsConfig): SandboxTool[] {
  return [...createSandboxCapabilityPlan(config).tools];
}

export function toolConfigDir(tool: SandboxTool, project: string, branch: string): string {
  return hostJoin(tool.sandboxBase, project, sanitizeBranchName(branch));
}

export function toolConfigDirCandidates(tool: SandboxTool, project: string, branch: string): string[] {
  return safeNameCandidates(branch).map((name) => hostJoin(tool.sandboxBase, project, name));
}

export function toolProjectDirCandidates(tool: SandboxTool, project: string): string[] {
  return [hostJoin(tool.sandboxBase, project)];
}

export function toolNpmPackagesArg(tools: SandboxTool[]): string {
  return tools
    .filter((tool) => tool.install.type === 'npm')
    .map((tool) => tool.install.cmd)
    .join(' ');
}

export function toolShellInstallScript(tools: SandboxTool[]): string {
  const blocks = tools
    .filter((tool) => tool.install.type === 'shell')
    .map((tool) => `# install: ${tool.id}\n${tool.install.cmd}`);

  if (blocks.length === 0) {
    return '';
  }

  return ['#!/bin/bash', 'set -e', '', ...blocks, ''].join('\n');
}

export function toolShellInstallScriptBase64(tools: SandboxTool[]): string {
  const script = toolShellInstallScript(tools);
  return script ? Buffer.from(script, 'utf8').toString('base64') : '';
}

export function imageSignatureFields(tools: SandboxTool[]): Array<{ id: string; install: SandboxToolInstall }> {
  return tools.map((tool) => ({ id: tool.id, install: tool.install }));
}
