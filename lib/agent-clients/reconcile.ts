import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import defaults from '../defaults.json' with { type: 'json' };
import { normalizeAgentClients, serializeAgentClients } from './config.ts';
import { normalizeCustomTUIs } from './custom-tuis.ts';
import { renderNextStepCommands } from './next-steps.ts';
import { planAgentClientProjectAssets } from './project-assets.ts';
import {
  listAgentClientAdapters,
  listEnabledAgentClientAdapters
} from './registry.ts';
import type { AgentClientProjectAssetPlan, ProjectFileRegistry } from './project-assets.ts';
import type { NextStepCommand } from './next-steps.ts';
import type { AgentClientDiagnostic } from './config.ts';
import type { AgentClientId, AgentClientState } from './types.ts';

type AgentClientWorkflowMutation =
  | Readonly<{ type: 'none' }>
  | Readonly<{ type: 'set-enabled'; id: AgentClientId; value: boolean }>
  | Readonly<{ type: 'replace-state'; state: AgentClientState }>;

type AgentClientSeedOperation = Readonly<{
  kind: 'write' | 'remove' | 'protect' | 'unchanged';
  clientId: AgentClientId;
  target: string;
  content?: string;
  reason?: 'user-modified' | 'unknown-origin';
}>;

type WorkflowDiagnostic = AgentClientDiagnostic | Readonly<{ code: string; path: string }>;

type AgentClientWorkflowPlan = Readonly<{
  source: 'canonical' | 'legacy';
  before: AgentClientState;
  desired: AgentClientState;
  nextConfig: Record<string, unknown>;
  projectAssets: AgentClientProjectAssetPlan;
  seedOperations: readonly AgentClientSeedOperation[];
  nextSteps: readonly NextStepCommand[];
  diagnostics: readonly WorkflowDiagnostic[];
  changed: boolean;
  projectRoot: string;
  configPath: string;
}>;

type AgentClientReconcileDependencies = Readonly<{
  mkdirSync?: typeof fs.mkdirSync;
  writeFileSync?: typeof fs.writeFileSync;
  renameSync?: typeof fs.renameSync;
  unlinkSync?: typeof fs.unlinkSync;
}>;

type AgentClientReconcileResult = Readonly<{
  status: 'applied' | 'unchanged';
  configUpdated: boolean;
  applied: readonly string[];
  protected: readonly string[];
  unchanged: readonly string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hash(content: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function trustedBaseline(value: unknown): string | null {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}

function cloneState(state: AgentClientState): AgentClientState {
  return Object.fromEntries(
    Object.entries(state).map(([id, value]) => [id, { ...value }])
  ) as AgentClientState;
}

function applyMutation(
  state: AgentClientState,
  mutation: AgentClientWorkflowMutation
): AgentClientState {
  if (mutation.type === 'none') return cloneState(state);
  if (mutation.type === 'replace-state') return cloneState(mutation.state);
  return Object.fromEntries(
    Object.entries(state).map(([id, value]) => [
      id,
      id === mutation.id ? { ...value, enabled: mutation.value } : { ...value }
    ])
  ) as AgentClientState;
}

function registryFrom(value: unknown): ProjectFileRegistry {
  const files = isRecord(value) ? value : {};
  const strings = (candidate: unknown): string[] => Array.isArray(candidate)
    ? candidate.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    managed: strings(files.managed),
    merged: strings(files.merged),
    ejected: strings(files.ejected)
  };
}

function isPathOwnedByOtherPlatform(relativePath: string, platformType: string): boolean {
  const top = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').split('/')[0] ?? '';
  return top.startsWith('.')
    && ['github', 'none'].includes(top.slice(1))
    && top.slice(1) !== platformType;
}

function renderSeed(content: string, config: Record<string, unknown>): string {
  return content
    .replaceAll('{{project}}', String(config.project ?? ''))
    .replaceAll('{{org}}', String(config.org ?? ''));
}

function planAgentClientReconciliation(input: Readonly<{
  config: Record<string, unknown>;
  mutation: AgentClientWorkflowMutation;
  projectRoot: string;
  templateRoot: string;
  platformType: string;
  language: string;
}>): AgentClientWorkflowPlan {
  const normalized = normalizeAgentClients(input.config);
  const desired = applyMutation(normalized.state, input.mutation);
  const adapters = listAgentClientAdapters();
  const current = registryFrom(input.config.files);
  const sharedDefaults = {
    managed: defaults.files.managed.filter((entry) =>
      !isPathOwnedByOtherPlatform(entry, input.platformType)
    ),
    merged: defaults.files.merged.filter((entry) =>
      !isPathOwnedByOtherPlatform(entry, input.platformType)
    ),
    ejected: defaults.files.ejected
  };
  const projectAssets = planAgentClientProjectAssets({
    current,
    sharedDefaults,
    enabledAdapters: listEnabledAgentClientAdapters(desired),
    allAdapters: adapters
  });

  const nextConfig = structuredClone(input.config);
  nextConfig.agentClients = serializeAgentClients(desired);
  delete nextConfig.tuis;
  if (normalized.remainingSandboxTools !== undefined) {
    const sandbox = isRecord(nextConfig.sandbox) ? { ...nextConfig.sandbox } : {};
    sandbox.tools = [
      'agent-infra',
      ...normalized.remainingSandboxTools.filter((tool) => tool !== 'agent-infra')
    ];
    nextConfig.sandbox = sandbox;
  }
  const existingFiles = isRecord(nextConfig.files) ? nextConfig.files : {};
  const existingBaselines = isRecord(existingFiles.managedBaselines)
    ? existingFiles.managedBaselines
    : {};
  const baselines: Record<string, unknown> = { ...existingBaselines };
  nextConfig.files = {
    ...existingFiles,
    managed: [...projectAssets.registry.managed],
    merged: [...projectAssets.registry.merged],
    ejected: [...projectAssets.registry.ejected],
    managedBaselines: baselines
  };

  const projectName = String(input.config.project ?? '');
  const language = input.language === 'zh-CN' ? 'zh-CN' : 'en';
  const seedOperations: AgentClientSeedOperation[] = [];
  for (const adapter of adapters) {
    for (const seed of adapter.project.seedCommands) {
      const relativeTarget = seed.target.replaceAll('${projectName}', projectName);
      const target = path.join(input.projectRoot, relativeTarget);
      const templatePath = path.join(input.templateRoot, seed.templates[language]);
      const content = renderSeed(fs.readFileSync(templatePath, 'utf8'), input.config);
      const templateHash = hash(content);
      const exists = fs.existsSync(target);
      const localHash = exists ? hash(fs.readFileSync(target)) : null;
      const baseline = trustedBaseline(baselines[relativeTarget]);
      const enabled = desired[adapter.id].enabled;

      if (enabled) {
        if (!exists || (baseline !== null && localHash === baseline)) {
          baselines[relativeTarget] = templateHash;
          seedOperations.push({
            kind: localHash === templateHash ? 'unchanged' : 'write',
            clientId: adapter.id,
            target: relativeTarget,
            ...(localHash === templateHash ? {} : { content })
          });
        } else if (localHash === templateHash) {
          baselines[relativeTarget] = templateHash;
          seedOperations.push({ kind: 'unchanged', clientId: adapter.id, target: relativeTarget });
        } else {
          seedOperations.push({
            kind: 'protect',
            clientId: adapter.id,
            target: relativeTarget,
            reason: baseline ? 'user-modified' : 'unknown-origin'
          });
        }
      } else if (!exists) {
        delete baselines[relativeTarget];
        seedOperations.push({ kind: 'unchanged', clientId: adapter.id, target: relativeTarget });
      } else if ((baseline !== null && localHash === baseline) || localHash === templateHash) {
        delete baselines[relativeTarget];
        seedOperations.push({ kind: 'remove', clientId: adapter.id, target: relativeTarget });
      } else {
        seedOperations.push({
          kind: 'protect',
          clientId: adapter.id,
          target: relativeTarget,
          reason: baseline ? 'user-modified' : 'unknown-origin'
        });
      }
    }
  }
  if (Object.keys(baselines).length === 0) {
    delete (nextConfig.files as Record<string, unknown>).managedBaselines;
  }

  const custom = normalizeCustomTUIs(input.projectRoot, input.config.customTUIs ?? []);
  const nextSteps = renderNextStepCommands({
    projectName,
    state: desired,
    customTUIs: custom.items,
    skillName: 'update-agent-infra'
  });
  const actionableSeed = seedOperations.some((operation) =>
    operation.kind === 'write' || operation.kind === 'remove'
  );
  const changed = JSON.stringify(nextConfig) !== JSON.stringify(input.config)
    || actionableSeed;

  return Object.freeze({
    source: normalized.source,
    before: normalized.state,
    desired,
    nextConfig,
    projectAssets,
    seedOperations: Object.freeze(seedOperations),
    nextSteps,
    diagnostics: Object.freeze([...normalized.diagnostics, ...custom.diagnostics]),
    changed,
    projectRoot: input.projectRoot,
    configPath: path.join(input.projectRoot, '.agents', '.airc.json')
  });
}

function applyAgentClientReconciliation(
  plan: AgentClientWorkflowPlan,
  dependencies: AgentClientReconcileDependencies = {}
): AgentClientReconcileResult {
  const mkdirSync = dependencies.mkdirSync ?? fs.mkdirSync;
  const writeFileSync = dependencies.writeFileSync ?? fs.writeFileSync;
  const renameSync = dependencies.renameSync ?? fs.renameSync;
  const unlinkSync = dependencies.unlinkSync ?? fs.unlinkSync;
  const applied: string[] = [];
  const protectedTargets: string[] = [];
  const unchanged: string[] = [];

  for (const operation of plan.seedOperations) {
    const target = path.join(plan.projectRoot, operation.target);
    if (operation.kind === 'write') {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, operation.content!, 'utf8');
      applied.push(operation.target);
    } else if (operation.kind === 'remove') {
      if (fs.existsSync(target)) unlinkSync(target);
      applied.push(operation.target);
    } else if (operation.kind === 'protect') {
      protectedTargets.push(operation.target);
    } else {
      unchanged.push(operation.target);
    }
  }

  const serialized = `${JSON.stringify(plan.nextConfig, null, 2)}\n`;
  const previous = fs.existsSync(plan.configPath)
    ? fs.readFileSync(plan.configPath, 'utf8')
    : null;
  const configUpdated = previous !== serialized;
  if (configUpdated) {
    mkdirSync(path.dirname(plan.configPath), { recursive: true });
    const temporary = `${plan.configPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(temporary, serialized, 'utf8');
      renameSync(temporary, plan.configPath);
    } catch (error) {
      try {
        if (fs.existsSync(temporary)) unlinkSync(temporary);
      } catch {
        // Preserve the original error; a later idempotent rerun can clean stale state.
      }
      throw error;
    }
  }

  return Object.freeze({
    status: configUpdated || applied.length > 0 ? 'applied' : 'unchanged',
    configUpdated,
    applied: Object.freeze(applied),
    protected: Object.freeze(protectedTargets),
    unchanged: Object.freeze(unchanged)
  });
}

export {
  applyAgentClientReconciliation,
  planAgentClientReconciliation
};
export type {
  AgentClientReconcileDependencies,
  AgentClientReconcileResult,
  AgentClientSeedOperation,
  AgentClientWorkflowMutation,
  AgentClientWorkflowPlan
};
