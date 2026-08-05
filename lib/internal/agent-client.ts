import fs from 'node:fs';
import path from 'node:path';

import {
  AgentClientConfigError,
  normalizeAgentClients
} from '../agent-clients/config.ts';
import { normalizeCustomTUIs } from '../agent-clients/custom-tuis.ts';
import { renderNextStepCommands } from '../agent-clients/next-steps.ts';

const USAGE = 'Usage: agent-infra-internal agent-client next-steps --skill <skill-name> [--task-ref <NN|TASK-id>] [--version <semver>] [--format text|json]\n';

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
  if (args[0] !== 'next-steps') {
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

function agentClient(args: string[] = []): void {
  const parsed = parseArgs(args);
  if (!parsed || process.exitCode) return;

  let config: Record<string, unknown>;
  try {
    const configPath = path.join(process.cwd(), '.agents', '.airc.json');
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('configuration root must be an object');
    }
    config = raw as Record<string, unknown>;
  } catch (error) {
    failure('AGENT_CLIENT_CONFIG_INVALID', String(error));
    return;
  }

  try {
    const clients = normalizeAgentClients(config);
    const custom = normalizeCustomTUIs(process.cwd(), config.customTUIs ?? []);
    const commands = renderNextStepCommands({
      projectName: String(config.project ?? ''),
      state: clients.state,
      customTUIs: custom.items,
      skillName: parsed.skillName,
      ...(parsed.taskRef ? { taskRef: parsed.taskRef } : {}),
      ...(parsed.version ? { version: parsed.version } : {})
    });
    if (parsed.format === 'json') {
      process.stdout.write(`${JSON.stringify({
        status: 'rendered',
        changed: false,
        commands,
        diagnostics: custom.diagnostics,
        error: null
      })}\n`);
      return;
    }
    for (const command of commands) {
      process.stdout.write(`  - ${command.displayName}: ${command.command}\n`);
    }
    for (const diagnostic of custom.diagnostics) {
      process.stderr.write(`${diagnostic.code} at ${diagnostic.path}\n`);
    }
  } catch (error) {
    if (error instanceof AgentClientConfigError) {
      failure(error.code, error.message);
      return;
    }
    failure(
      'AGENT_CLIENT_RENDER_INVALID',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export { agentClient };
