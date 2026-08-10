import {
  AGENT_CLIENT_CAPABILITY_IDS,
  AGENT_CLIENT_SUPPORT_LEVELS,
  isAgentClientId
} from './types.ts';
import type {
  AgentClientCapabilityMap,
  AgentClientId
} from './types.ts';
import {
  SANDBOX_HOOK_PHASES
} from '../sandbox/tool-types.ts';
import type {
  AgentClientSandboxRecoveryCheck,
  AgentClientSandboxDescriptor,
  SandboxAlias,
  SandboxTool,
  SandboxToolContext
} from '../sandbox/tool-types.ts';

type AgentClientCapabilities = AgentClientCapabilityMap;

type AgentClientModelSelectionContext =
  | Readonly<{
      kind: 'catalog';
      completeness: 'complete' | 'partial';
      source: string;
      models: readonly Readonly<{
        id: string;
        reasoningEfforts?: readonly string[];
      }>[];
      guidance?: string;
    }>
  | Readonly<{
      kind: 'interactive-only';
      command: string;
      guidance: string;
    }>;

type AgentClientDelegationEvidence = Readonly<{
  actualModel: 'host-event' | 'unavailable';
  actualReasoningEffort: 'host-event' | 'spawn-ack' | 'unavailable';
}>;

type AgentClientSeedCommand = Readonly<{
  templates: Readonly<{
    en: string;
    'zh-CN': string;
  }>;
  target: string;
}>;

type AgentClientCustomCommandDescriptor = Readonly<{
  target: string;
  frontmatter: Readonly<Record<string, string | boolean>>;
  argumentsToken?: string;
}>;

type AgentClientProjectDescriptor = Readonly<{
  ownedPathPrefixes: readonly string[];
  managed: readonly string[];
  merged: readonly string[];
  ejected: readonly string[];
  seedCommands: readonly AgentClientSeedCommand[];
  customCommand?: AgentClientCustomCommandDescriptor;
}>;

type AgentClientAdapter = Readonly<{
  id: AgentClientId;
  displayName: string;
  invocation: string;
  capabilities: AgentClientCapabilities;
  modelSelection: AgentClientModelSelectionContext;
  delegationEvidence: AgentClientDelegationEvidence;
  project: AgentClientProjectDescriptor;
  sandbox: AgentClientSandboxDescriptor;
}>;

type AgentClientRegistry = Readonly<
  Record<AgentClientId, AgentClientAdapter>
>;

type AgentClientManifestEntry = Readonly<{
  id: AgentClientId;
  displayName: string;
  invocation: string;
  ownedPathPrefixes: readonly string[];
  managed: readonly string[];
  merged: readonly string[];
  ejected: readonly string[];
  customCommand?: AgentClientCustomCommandDescriptor;
}>;

const PROJECT_ASSET_CATEGORIES = ['managed', 'merged', 'ejected'] as const;
const MAX_SANDBOX_HOOK_TIMEOUT_MS = 300_000;
const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function freezeRecoveryProbe(
  id: AgentClientId,
  checkId: string,
  value: AgentClientSandboxRecoveryCheck['probe']
): AgentClientSandboxRecoveryCheck['probe'] {
  if (
    !value
    || typeof value.script !== 'string'
    || value.script.trim() === ''
    || !Array.isArray(value.args)
    || value.args.some((arg) => typeof arg !== 'string')
    || (value.user !== undefined && (typeof value.user !== 'string' || value.user === ''))
  ) {
    throw new Error(`Agent Client '${id}' recovery check '${checkId}' has an invalid probe`);
  }
  return Object.freeze({
    script: value.script,
    args: Object.freeze([...value.args]),
    ...(value.user === undefined ? {} : { user: value.user })
  });
}

function freezeTool(tool: SandboxTool): SandboxTool {
  if (typeof tool.id !== 'string' || !TOOL_ID_PATTERN.test(tool.id)) {
    throw new Error(`Invalid sandbox tool id: ${String(tool.id)}`);
  }
  if (!tool.install?.cmd || !['npm', 'shell'].includes(tool.install.type)) {
    throw new Error(`Sandbox tool '${tool.id}' has invalid install`);
  }
  if (!tool.containerMount.startsWith('/')) {
    throw new Error(`Sandbox tool '${tool.id}' containerMount must be absolute`);
  }
  if (!tool.versionCmd) {
    throw new Error(`Sandbox tool '${tool.id}' requires versionCmd`);
  }
  return Object.freeze({
    ...tool,
    install: Object.freeze({ ...tool.install }),
    ...(tool.envVars ? { envVars: Object.freeze({ ...tool.envVars }) } : {}),
    ...(tool.hostPreSeedFiles ? {
      hostPreSeedFiles: Object.freeze(tool.hostPreSeedFiles.map((entry) => Object.freeze({ ...entry })))
    } : {}),
    ...(tool.hostPreSeedDirs ? {
      hostPreSeedDirs: Object.freeze(tool.hostPreSeedDirs.map((entry) => Object.freeze({ ...entry })))
    } : {}),
    ...(tool.pathRewriteFiles ? { pathRewriteFiles: Object.freeze([...tool.pathRewriteFiles]) } : {}),
    ...(tool.hostLiveMounts ? {
      hostLiveMounts: Object.freeze(tool.hostLiveMounts.map((entry) => Object.freeze({ ...entry })))
    } : {}),
    ...(tool.postSetupCmds ? { postSetupCmds: Object.freeze([...tool.postSetupCmds]) } : {}),
    ...(tool.tmpfs ? {
      tmpfs: Object.freeze({
        ...tool.tmpfs,
        ...(tool.tmpfs.seed ? { seed: Object.freeze([...tool.tmpfs.seed]) } : {})
      })
    } : {})
  }) as SandboxTool;
}

function freezeAliases(id: AgentClientId, aliases: readonly SandboxAlias[]): readonly SandboxAlias[] {
  const names = new Set<string>();
  return Object.freeze(aliases.map((alias) => {
    if (!alias.name || !alias.command || names.has(alias.name)) {
      throw new Error(`Agent Client '${id}' has invalid or duplicate sandbox alias '${alias.name}'`);
    }
    names.add(alias.name);
    return Object.freeze({ ...alias });
  }));
}

function isProjectRelativeLiteral(value: string): boolean {
  if (
    value.length === 0
    || value.startsWith('/')
    || /^[a-zA-Z]:/.test(value)
    || value.includes('\\')
    || /[*?[\]{}]/.test(value)
  ) {
    return false;
  }
  return !value.split('/').some((segment) => segment === '..');
}

function defineAgentClientAdapter(
  candidate: AgentClientAdapter
): AgentClientAdapter {
  if (!isAgentClientId(candidate.id)) {
    throw new Error(`Unknown Agent Client ID '${String(candidate.id)}'`);
  }
  if (typeof candidate.displayName !== 'string' || candidate.displayName.trim() === '') {
    throw new Error(`Agent Client '${candidate.id}' requires a display name`);
  }
  if (
    typeof candidate.invocation !== 'string'
    || candidate.invocation.trim() === ''
    || /[\r\n]/.test(candidate.invocation)
  ) {
    throw new Error(`Agent Client '${candidate.id}' requires a single-line invocation`);
  }
  const invocationPlaceholders = [
    ...candidate.invocation.matchAll(/\$\{([^}]+)\}/g)
  ].map((match) => match[1]);
  if (
    !invocationPlaceholders.includes('skillName')
    || invocationPlaceholders.some((placeholder) =>
      placeholder !== 'skillName' && placeholder !== 'projectName'
    )
    || candidate.invocation
      .replaceAll('${skillName}', '')
      .replaceAll('${projectName}', '')
      .includes('${')
  ) {
    throw new Error(`Agent Client '${candidate.id}' has an invalid invocation`);
  }

  if (
    typeof candidate.capabilities !== 'object'
    || candidate.capabilities === null
    || Array.isArray(candidate.capabilities)
  ) {
    throw new Error(`Agent Client '${candidate.id}' has an invalid capability map`);
  }
  const capabilityKeys = Object.keys(candidate.capabilities);
  if (
    capabilityKeys.length !== AGENT_CLIENT_CAPABILITY_IDS.length
    || AGENT_CLIENT_CAPABILITY_IDS.some((capability) =>
      !Object.prototype.hasOwnProperty.call(candidate.capabilities, capability)
    )
  ) {
    throw new Error(`Agent Client '${candidate.id}' has an invalid capability map`);
  }

  const capabilities = Object.fromEntries(
    AGENT_CLIENT_CAPABILITY_IDS.map((capability) => {
      const support = candidate.capabilities[capability];
      if (
        typeof support !== 'object'
        || support === null
        || !AGENT_CLIENT_SUPPORT_LEVELS.includes(support.level)
      ) {
        throw new Error(
          `Agent Client '${candidate.id}' has invalid support for '${capability}'`
        );
      }
      return [capability, Object.freeze({ level: support.level })];
    })
  ) as AgentClientCapabilities;

  const modelSelection = candidate.modelSelection;
  if (!modelSelection || typeof modelSelection !== 'object') {
    throw new Error(`Agent Client '${candidate.id}' has an invalid model-selection context`);
  }
  let frozenModelSelection: AgentClientModelSelectionContext;
  if (modelSelection.kind === 'interactive-only') {
    if (!modelSelection.command?.trim() || !modelSelection.guidance?.trim()) {
      throw new Error(`Agent Client '${candidate.id}' has an invalid model-selection context`);
    }
    frozenModelSelection = Object.freeze({ ...modelSelection });
  } else if (
    modelSelection.kind === 'catalog'
    && ['complete', 'partial'].includes(modelSelection.completeness)
    && typeof modelSelection.source === 'string'
    && modelSelection.source.trim() !== ''
    && Array.isArray(modelSelection.models)
  ) {
    const models = modelSelection.models.map((model) => {
      if (!model?.id?.trim() || (model.reasoningEfforts && !Array.isArray(model.reasoningEfforts))) {
        throw new Error(`Agent Client '${candidate.id}' has an invalid model-selection context`);
      }
      return Object.freeze({
        id: model.id,
        ...(model.reasoningEfforts
          ? { reasoningEfforts: Object.freeze([...model.reasoningEfforts]) }
          : {})
      });
    });
    frozenModelSelection = Object.freeze({
      ...modelSelection,
      models: Object.freeze(models)
    });
  } else {
    throw new Error(`Agent Client '${candidate.id}' has an invalid model-selection context`);
  }

  const evidence = candidate.delegationEvidence;
  if (
    !evidence
    || !['host-event', 'unavailable'].includes(evidence.actualModel)
    || !['host-event', 'spawn-ack', 'unavailable'].includes(evidence.actualReasoningEffort)
  ) {
    throw new Error(`Agent Client '${candidate.id}' has invalid delegation evidence`);
  }

  if (
    typeof candidate.project !== 'object'
    || candidate.project === null
    || Array.isArray(candidate.project)
  ) {
    throw new Error(`Agent Client '${candidate.id}' has an invalid project descriptor`);
  }
  const ownedPathPrefixes = candidate.project.ownedPathPrefixes;
  if (!Array.isArray(ownedPathPrefixes)) {
    throw new Error(`Agent Client '${candidate.id}' has invalid owned path prefixes`);
  }

  const paths = ownedPathPrefixes.map((prefix) => {
    if (
      typeof prefix !== 'string'
      || !isProjectRelativeLiteral(prefix)
      || !prefix.endsWith('/')
    ) {
      throw new Error(
        `Agent Client '${candidate.id}' has invalid owned path prefix '${String(prefix)}'`
      );
    }
    return prefix;
  });
  if (new Set(paths).size !== paths.length) {
    throw new Error(`Agent Client '${candidate.id}' has duplicate owned path prefixes`);
  }

  const projectAssets = Object.fromEntries(
    PROJECT_ASSET_CATEGORIES.map((category) => {
      const values = candidate.project[category];
      if (!Array.isArray(values)) {
        throw new Error(
          `Agent Client '${candidate.id}' has invalid '${category}' project assets`
        );
      }
      const assets = values.map((asset) => {
        if (
          typeof asset !== 'string'
          || !isProjectRelativeLiteral(asset)
          || !paths.some((prefix) =>
            asset === prefix.slice(0, -1) || asset.startsWith(prefix)
          )
        ) {
          throw new Error(
            `Agent Client '${candidate.id}' has invalid '${category}' project asset '${String(asset)}'`
          );
        }
        return asset;
      });
      if (new Set(assets).size !== assets.length) {
        throw new Error(
          `Agent Client '${candidate.id}' has duplicate '${category}' project assets`
        );
      }
      return [category, Object.freeze(assets)];
    })
  ) as Pick<AgentClientProjectDescriptor, 'managed' | 'merged' | 'ejected'>;

  const categorizedAssets = PROJECT_ASSET_CATEGORIES.flatMap((category) =>
    projectAssets[category].map((asset) => ({ asset, category }))
  );
  const seenAssets = new Map<string, string>();
  for (const { asset, category } of categorizedAssets) {
    const previous = seenAssets.get(asset);
    if (previous) {
      throw new Error(
        `Agent Client '${candidate.id}' project asset '${asset}' overlaps '${previous}' and '${category}'`
      );
    }
    seenAssets.set(asset, category);
  }

  if (!Array.isArray(candidate.project.seedCommands)) {
    throw new Error(`Agent Client '${candidate.id}' has invalid seed commands`);
  }
  const seedTargets = new Set<string>();
  const seedCommands = candidate.project.seedCommands.map((seed) => {
    if (!seed || typeof seed !== 'object') {
      throw new Error(`Agent Client '${candidate.id}' has an invalid seed command`);
    }
    const placeholders = [
      ...seed.target.matchAll(/\$\{([^}]+)\}/g)
    ].map((match) => match[1]);
    const targetProbe = seed.target.replaceAll('${projectName}', 'project');
    if (
      placeholders.some((placeholder) => placeholder !== 'projectName')
      || targetProbe.includes('${')
      || !isProjectRelativeLiteral(targetProbe)
      || !paths.some((prefix) =>
        targetProbe === prefix.slice(0, -1) || targetProbe.startsWith(prefix)
      )
      || seedTargets.has(seed.target)
    ) {
      throw new Error(
        `Agent Client '${candidate.id}' has invalid seed target '${String(seed.target)}'`
      );
    }
    if (
      !seed.templates
      || typeof seed.templates.en !== 'string'
      || typeof seed.templates['zh-CN'] !== 'string'
      || !isProjectRelativeLiteral(seed.templates.en)
      || !isProjectRelativeLiteral(seed.templates['zh-CN'])
    ) {
      throw new Error(`Agent Client '${candidate.id}' has invalid seed templates`);
    }
    seedTargets.add(seed.target);
    return Object.freeze({
      templates: Object.freeze({ ...seed.templates }),
      target: seed.target
    });
  });

  let customCommand: AgentClientCustomCommandDescriptor | undefined;
  if (candidate.project.customCommand !== undefined) {
    const descriptor = candidate.project.customCommand;
    const placeholders = typeof descriptor?.target === 'string'
      ? [...descriptor.target.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1])
      : [];
    const targetProbe = typeof descriptor?.target === 'string'
      ? descriptor.target.replaceAll('${skillName}', 'skill')
      : '';
    const frontmatter = descriptor?.frontmatter;
    if (
      !descriptor
      || typeof descriptor !== 'object'
      || placeholders.length !== 1
      || placeholders[0] !== 'skillName'
      || targetProbe.includes('${')
      || !isProjectRelativeLiteral(targetProbe)
      || !paths.some((prefix) => targetProbe.startsWith(prefix))
      || !frontmatter
      || typeof frontmatter !== 'object'
      || Array.isArray(frontmatter)
      || Object.values(frontmatter).some((value) =>
        typeof value !== 'string' && typeof value !== 'boolean'
      )
      || (
        descriptor.argumentsToken !== undefined
        && (
          typeof descriptor.argumentsToken !== 'string'
          || descriptor.argumentsToken === ''
          || /[\r\n]/.test(descriptor.argumentsToken)
        )
      )
    ) {
      throw new Error(`Agent Client '${candidate.id}' has an invalid custom command`);
    }
    customCommand = Object.freeze({
      target: descriptor.target,
      frontmatter: Object.freeze({ ...frontmatter }),
      ...(descriptor.argumentsToken === undefined
        ? {}
        : { argumentsToken: descriptor.argumentsToken })
    });
  }

  if (!candidate.sandbox || typeof candidate.sandbox.createTool !== 'function') {
    throw new Error(`Agent Client '${candidate.id}' requires a sandbox descriptor`);
  }
  const hookIds = new Set<string>();
  const hooks = Object.freeze(candidate.sandbox.hooks.map((hook) => {
    if (
      !hook.id
      || hookIds.has(hook.id)
      || !SANDBOX_HOOK_PHASES.includes(hook.phase)
      || typeof hook.run !== 'function'
    ) {
      throw new Error(`Agent Client '${candidate.id}' has an invalid sandbox hook`);
    }
    if (
      hook.timeoutMs !== undefined
      && (
        !Number.isInteger(hook.timeoutMs)
        || hook.timeoutMs <= 0
        || hook.timeoutMs > MAX_SANDBOX_HOOK_TIMEOUT_MS
      )
    ) {
      throw new Error(`Agent Client '${candidate.id}' hook '${hook.id}' has invalid timeoutMs`);
    }
    hookIds.add(hook.id);
    return Object.freeze({ ...hook });
  }));
  const recoveryCheckIds = new Set<string>();
  if (
    candidate.sandbox.recoveryChecks !== undefined
    && !Array.isArray(candidate.sandbox.recoveryChecks)
  ) {
    throw new Error(`Agent Client '${candidate.id}' has invalid recovery checks`);
  }
  const recoveryChecks = Object.freeze(
    (candidate.sandbox.recoveryChecks ?? []).map((check) => {
      if (
        !check
        || typeof check.id !== 'string'
        || !TOOL_ID_PATTERN.test(check.id)
        || recoveryCheckIds.has(check.id)
      ) {
        throw new Error(`Agent Client '${candidate.id}' has an invalid recovery check`);
      }
      const probe = freezeRecoveryProbe(candidate.id, check.id, check.probe);
      const when = check.when === undefined
        ? undefined
        : freezeRecoveryProbe(candidate.id, check.id, check.when);
      if (
        !check.finding
        || !['permissions', 'builtin-link', 'hard-failure'].includes(check.finding.repairKind)
        || typeof check.finding.message !== 'string'
        || check.finding.message.trim() === ''
        || (
          check.finding.path !== undefined
          && (typeof check.finding.path !== 'string' || !check.finding.path.startsWith('/'))
        )
        || (
          check.finding.repairKind === 'permissions'
          && check.finding.path === undefined
        )
      ) {
        throw new Error(
          `Agent Client '${candidate.id}' recovery check '${check.id}' has an invalid finding`
        );
      }
      let repair: AgentClientSandboxRecoveryCheck['repair'];
      if (check.repair !== undefined) {
        if (
          typeof check.repair.user !== 'string'
          || check.repair.user === ''
          || typeof check.repair.command !== 'string'
          || check.repair.command === ''
          || !Array.isArray(check.repair.args)
          || check.repair.args.some((arg: unknown) => typeof arg !== 'string')
        ) {
          throw new Error(
            `Agent Client '${candidate.id}' recovery check '${check.id}' has an invalid repair`
          );
        }
        repair = Object.freeze({
          user: check.repair.user,
          command: check.repair.command,
          args: Object.freeze([...check.repair.args])
        });
      }
      if (check.finding.repairKind === 'builtin-link' && repair === undefined) {
        throw new Error(
          `Agent Client '${candidate.id}' recovery check '${check.id}' requires a repair`
        );
      }
      recoveryCheckIds.add(check.id);
      return Object.freeze({
        id: check.id,
        ...(when === undefined ? {} : { when }),
        probe,
        finding: Object.freeze({ ...check.finding }),
        ...(repair === undefined ? {} : { repair })
      });
    })
  );
  const aliases = freezeAliases(candidate.id, candidate.sandbox.aliases);
  const createTool = (context: SandboxToolContext): SandboxTool => {
    const tool = freezeTool(candidate.sandbox.createTool(context));
    if (tool.id !== candidate.id) {
      throw new Error(
        `Agent Client '${candidate.id}' sandbox tool id must match the adapter id`
      );
    }
    return tool;
  };

  return Object.freeze({
    id: candidate.id,
    displayName: candidate.displayName,
    invocation: candidate.invocation,
    capabilities: Object.freeze(capabilities),
    modelSelection: frozenModelSelection,
    delegationEvidence: Object.freeze({ ...evidence }),
    project: Object.freeze({
      ownedPathPrefixes: Object.freeze(paths),
      ...projectAssets,
      seedCommands: Object.freeze(seedCommands),
      ...(customCommand === undefined ? {} : { customCommand })
    }),
    sandbox: Object.freeze({ createTool, aliases, hooks, recoveryChecks })
  });
}

export { defineAgentClientAdapter };
export type {
  AgentClientAdapter,
  AgentClientCapabilities,
  AgentClientCustomCommandDescriptor,
  AgentClientDelegationEvidence,
  AgentClientManifestEntry,
  AgentClientModelSelectionContext,
  AgentClientProjectDescriptor,
  AgentClientSeedCommand,
  AgentClientRegistry
};
