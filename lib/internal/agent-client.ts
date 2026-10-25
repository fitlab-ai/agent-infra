import fs from 'node:fs';
import path from 'node:path';

import {
  AgentClientConfigError,
  normalizeAgentClients
} from '../agent-clients/config.ts';
import { normalizeCustomToolInvocations } from '../agent-clients/custom-tool-invocations.ts';
import { renderNextStepCommands } from '../agent-clients/next-steps.ts';
import { getAgentClientModelSelection } from '../agent-clients/registry.ts';
import { isAgentClientId } from '../agent-clients/types.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal agent-client <next-steps|model-selection> [options]\n';

type ParsedArgs = Readonly<{
  skillName: string;
  taskRef?: string;
  version?: string;
  format: 'text' | 'json';
}>;

function failure(code: string, message: string): void {
  process.stdout.write(`${JSON.stringify({
    status: 'failed',
    changed: false,
    commands: [],
    diagnostics: [],
    error: { code, message }
  })}\n`);
  process.exitCode = 1;
}

function parseArgs(args: string[]): ParsedArgs | null {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return null;
  }
  if (!internalHandlerRoute('agent-client', 'next-steps', args[0] ?? '')) {
    failure('AGENT_CLIENT_PAYLOAD_INVALID', "operation must be 'next-steps'");
    return null;
  }
  let skillName: string | undefined;
  let taskRef: string | undefined;
  let version: string | undefined;
  let format: 'text' | 'json' = 'text';
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!['--skill', '--task-ref', '--version', '--format'].includes(flag)) {
      failure('AGENT_CLIENT_PAYLOAD_INVALID', `unknown option '${flag}'`);
      return null;
    }
    if (seen.has(flag)) {
      failure('AGENT_CLIENT_PAYLOAD_INVALID', `duplicate option '${flag}'`);
      return null;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) {
      failure('AGENT_CLIENT_PAYLOAD_INVALID', `option '${flag}' requires a value`);
      return null;
    }
    seen.add(flag);
    if (flag === '--skill') skillName = value;
    if (flag === '--task-ref') taskRef = value;
    if (flag === '--version') version = value;
    if (flag === '--format') {
      if (value !== 'text' && value !== 'json') {
        failure('AGENT_CLIENT_PAYLOAD_INVALID', "format must be 'text' or 'json'");
        return null;
      }
      format = value;
    }
  }
  if (!skillName) {
    failure('AGENT_CLIENT_PAYLOAD_INVALID', "option '--skill' is required");
    return null;
  }
  return {
    skillName,
    ...(taskRef ? { taskRef } : {}),
    ...(version ? { version } : {}),
    format
  };
}

function modelSelection(args: string[]): void {
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!['--client', '--format'].includes(flag) || seen.has(flag)) {
      failure('AGENT_CLIENT_PAYLOAD_INVALID', `invalid or duplicate option '${flag}'`);
      return;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) {
      failure('AGENT_CLIENT_PAYLOAD_INVALID', `option '${flag}' requires a value`);
      return;
    }
    seen.add(flag);
    values[flag] = value;
  }
  const client = values['--client'];
  const format = values['--format'] ?? 'text';
  if (!isAgentClientId(client) || !['text', 'json'].includes(format)) {
    failure('AGENT_CLIENT_PAYLOAD_INVALID', 'model-selection requires a known --client and text|json format');
    return;
  }
  const context = getAgentClientModelSelection(client);
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ status: 'resolved', changed: false, client, context, error: null })}\n`);
    return;
  }
  renderModelSelection(context);
}

function renderModelSelection(context: ReturnType<typeof getAgentClientModelSelection>): void {
  if (context.kind === 'interactive-only') {
    process.stdout.write(`Model selection: interactive-only\nCommand: ${context.command}\n${context.guidance}\n`);
    return;
  }
  process.stdout.write(`Model selection: ${context.completeness} catalog\nSource: ${context.source}\n`);
  for (const model of context.models) {
    const efforts = model.reasoningEfforts?.length ? ` (${model.reasoningEfforts.join(', ')})` : '';
    process.stdout.write(`- ${model.id}${efforts}\n`);
  }
  if (context.guidance) process.stdout.write(`${context.guidance}\n`);
}

function renderNextSteps(args: string[]): void {
  const parsed = parseArgs(args);
  if (!parsed || process.exitCode) return;
  const config = readAgentClientConfig();
  if (!config) return;
  try {
    const clients = normalizeAgentClients(config);
    const custom = normalizeCustomToolInvocations(config);
    const commands = renderNextStepCommands({
      projectName: String(config.project ?? ''),
      state: clients.state,
      customToolInvocations: custom.items,
      skillName: parsed.skillName,
      ...(parsed.taskRef ? { taskRef: parsed.taskRef } : {}),
      ...(parsed.version ? { version: parsed.version } : {})
    });
    writeNextStepOutput(parsed.format, commands, custom.diagnostics);
  } catch (error) {
    if (error instanceof AgentClientConfigError) {
      failure(error.code, error.message);
      return;
    }
    failure('AGENT_CLIENT_RENDER_INVALID', error instanceof Error ? error.message : String(error));
  }
}

function readAgentClientConfig(): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.agents', '.airc.json'), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('configuration root must be an object');
    return raw as Record<string, unknown>;
  } catch (error) {
    failure('AGENT_CLIENT_CONFIG_INVALID', String(error));
    return null;
  }
}

function writeNextStepOutput(
  format: ParsedArgs['format'],
  commands: ReturnType<typeof renderNextStepCommands>,
  diagnostics: ReturnType<typeof normalizeCustomToolInvocations>['diagnostics']
): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ status: 'rendered', changed: false, commands, diagnostics, error: null })}\n`);
    return;
  }
  for (const command of commands) process.stdout.write(`  - ${command.displayName}: ${command.command}\n`);
  for (const diagnostic of diagnostics) process.stderr.write(`${diagnostic.code} at ${diagnostic.path}\n`);
}

function agentClient(args: string[] = []): void {
  if (!ensureInternalHandlerRoute('agent-client', args)) return;
  if (internalHandlerRoute('agent-client', 'model-selection', args[0] ?? '')) {
    return modelSelection(args);
  }
  renderNextSteps(args);
}

export { agentClient };
