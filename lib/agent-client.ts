import fs from 'node:fs';
import path from 'node:path';

import { AgentClientConfigError, normalizeAgentClients } from './agent-clients/config.ts';
import {
  applyAgentClientReconciliation,
  planAgentClientReconciliation
} from './agent-clients/reconcile.ts';
import { listAgentClientAdapters } from './agent-clients/registry.ts';
import { AGENT_CLIENT_IDS, isAgentClientId } from './agent-clients/types.ts';
import type { AgentClientState } from './agent-clients/types.ts';
import { closePrompt, multiSelect } from './prompt.ts';
import { resolveTemplateDir } from './paths.ts';
import { PUBLIC_CLI_ROUTE_SELECTORS } from './internal/cli-route-inventory.ts';

const AGENT_CLIENT_OPERATIONS = PUBLIC_CLI_ROUTE_SELECTORS['agent-client'];

const USAGE = `Usage: ai agent-client <operation>

Operations:
  list                 List built-in Agent Clients
  status               Show project integration and sandbox state
  enable <client-id>   Enable project integration only
  disable <client-id>  Disable project integration only
  configure            Configure integration and sandbox state interactively
`;

class AgentClientCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AgentClientCommandError';
    this.code = code;
  }
}

function readConfig(projectRoot: string): Record<string, unknown> {
  const configPath = path.join(projectRoot, '.agents', '.airc.json');
  if (!fs.existsSync(configPath)) {
    throw new AgentClientCommandError(
      'AGENT_CLIENT_CONFIG_NOT_FOUND',
      'No .agents/.airc.json found. Run "ai init" first.'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new AgentClientCommandError(
      'AGENT_CLIENT_CONFIG_INVALID',
      error instanceof Error ? error.message : String(error)
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AgentClientCommandError(
      'AGENT_CLIENT_CONFIG_INVALID',
      'configuration root must be an object'
    );
  }
  return parsed as Record<string, unknown>;
}

function choices() {
  return listAgentClientAdapters().map((adapter) => ({
    id: adapter.id,
    label: adapter.displayName
  }));
}

function selected(state: AgentClientState, field: 'enabled' | 'installInSandbox'): string[] {
  return AGENT_CLIENT_IDS.filter((id) => state[id][field]);
}

function workflowPlan(
  projectRoot: string,
  config: Record<string, unknown>,
  mutation: Parameters<typeof planAgentClientReconciliation>[0]['mutation']
) {
  const templateRoot = resolveTemplateDir();
  if (!templateRoot) {
    throw new AgentClientCommandError('AGENT_CLIENT_TEMPLATE_NOT_FOUND', 'Template directory not found');
  }
  const platform = config.platform;
  const platformType = typeof platform === 'object' && platform !== null && 'type' in platform
    ? String(platform.type ?? 'github')
    : 'github';
  return planAgentClientReconciliation({
    config,
    mutation,
    projectRoot,
    templateRoot,
    platformType,
    language: String(config.language ?? 'en')
  });
}

function printState(state: AgentClientState): void {
  for (const adapter of listAgentClientAdapters()) {
    const value = state[adapter.id];
    process.stdout.write(
      `  ${adapter.id}: enabled=${String(value.enabled)} installInSandbox=${String(value.installInSandbox)}\n`
    );
  }
}

async function cmdAgentClient(args: string[]): Promise<number> {
  const operation = args[0];
  if (!operation || operation === '--help' || operation === '-h' || operation === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!AGENT_CLIENT_OPERATIONS.includes(operation as typeof AGENT_CLIENT_OPERATIONS[number])) {
    throw new AgentClientCommandError(
      'AGENT_CLIENT_OPERATION_INVALID',
      `Unknown operation '${operation}'`
    );
  }

  if (operation === 'list') {
    if (args.length !== 1) {
      throw new AgentClientCommandError('AGENT_CLIENT_ARGUMENT_INVALID', 'list accepts no arguments');
    }
    for (const adapter of listAgentClientAdapters()) {
      process.stdout.write(
        `${adapter.id}\t${adapter.displayName}\t${adapter.invocation}\tcommands=${adapter.capabilities.commands.level}\tsandbox=${adapter.capabilities.sandbox.level}\n`
      );
    }
    return 0;
  }

  const projectRoot = process.cwd();
  const config = readConfig(projectRoot);
  try {
    if (operation === 'status') {
      if (args.length !== 1) {
        throw new AgentClientCommandError('AGENT_CLIENT_ARGUMENT_INVALID', 'status accepts no arguments');
      }
      const plan = workflowPlan(projectRoot, config, { type: 'none' });
      printState(plan.desired);
      for (const seed of plan.seedOperations) {
        process.stdout.write(`  seed ${seed.target}: ${seed.kind}\n`);
      }
      for (const diagnostic of plan.diagnostics) {
        process.stdout.write(`  diagnostic ${diagnostic.code} at ${diagnostic.path}\n`);
      }
      return 0;
    }

    if (operation === 'enable' || operation === 'disable') {
      if (args.length !== 2) {
        throw new AgentClientCommandError(
          'AGENT_CLIENT_ARGUMENT_INVALID',
          `${operation} requires exactly one client id`
        );
      }
      const id = args[1];
      if (!isAgentClientId(id)) {
        throw new AgentClientCommandError('UNKNOWN_AGENT_CLIENT', `Unknown Agent Client '${String(id)}'`);
      }
      const plan = workflowPlan(projectRoot, config, {
        type: 'set-enabled',
        id,
        value: operation === 'enable'
      });
      process.stdout.write('Before:\n');
      printState(plan.before);
      const result = applyAgentClientReconciliation(plan);
      process.stdout.write('After:\n');
      printState(plan.desired);
      process.stdout.write(
        `Result: ${result.status}; applied=${result.applied.length}; protected=${result.protected.length}\n`
      );
      return 0;
    }

    if (operation === 'configure') {
      if (args.length !== 1) {
        throw new AgentClientCommandError('AGENT_CLIENT_ARGUMENT_INVALID', 'configure accepts no arguments');
      }
      const normalized = normalizeAgentClients(config);
      let enabled: string[];
      let installed: string[];
      try {
        enabled = await multiSelect(
          'Agent Client project integrations',
          choices(),
          selected(normalized.state, 'enabled')
        );
        installed = await multiSelect(
          'Agent Clients installed in sandbox',
          choices(),
          selected(normalized.state, 'installInSandbox')
        );
      } finally {
        closePrompt();
      }
      const state = Object.fromEntries(AGENT_CLIENT_IDS.map((id) => [id, {
        enabled: enabled.includes(id),
        installInSandbox: installed.includes(id)
      }])) as AgentClientState;
      const plan = workflowPlan(projectRoot, config, { type: 'replace-state', state });
      const result = applyAgentClientReconciliation(plan);
      process.stdout.write(
        `Result: ${result.status}; applied=${result.applied.length}; protected=${result.protected.length}\n`
      );
      return 0;
    }

    throw new AgentClientCommandError(
      'AGENT_CLIENT_OPERATION_INVALID',
      `Unknown operation '${operation}'`
    );
  } catch (error) {
    if (error instanceof AgentClientConfigError) {
      throw new AgentClientCommandError(error.code, error.message);
    }
    throw error;
  }
}

export { AgentClientCommandError, cmdAgentClient };
