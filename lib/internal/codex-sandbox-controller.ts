import {
  runCodexSandboxController,
  verifyCodexSandboxControllerContextWithWarnings
} from '../agent-clients/adapters/codex-lifecycle/sandbox-controller.ts';
import { ensureInternalHandlerRoute } from './cli-route-inventory.ts';

const USAGE = 'Usage: agent-infra-internal codex-sandbox-controller <run|verify-context> [options]\n';

function fail(code: string, message: string, exitCode = 1): void {
  process.stdout.write(`${JSON.stringify({
    status: 'failed',
    changed: false,
    error: { code, message }
  })}\n`);
  process.exitCode = exitCode;
}

function parse(args: string[]): Readonly<{ operation: string; values: Readonly<Record<string, string>> }> | null {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return null;
  }
  const operation = args[0];
  if (!operation || !['run', 'verify-context'].includes(operation)) {
    process.stderr.write(USAGE);
    fail('CODEX_SANDBOX_CONTROLLER_PAYLOAD_INVALID', 'operation must be run or verify-context', 2);
    return null;
  }
  const allowed = new Set([
    '--context',
    '--executor-model',
    '--executor-reasoning-effort',
    '--reviewer-model',
    '--reviewer-reasoning-effort'
  ]);
  const values: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--task-id' || flag.startsWith('--task-id=')
      || flag === '--task-ref' || flag.startsWith('--task-ref=')) {
      fail('CODEX_SANDBOX_CONTROLLER_IDENTITY_OPTION_UNSUPPORTED', 'controller task identity options are not supported', 2);
      return null;
    }
    const value = args[++index];
    if (!allowed.has(flag) || Object.hasOwn(values, flag) || !value || value.startsWith('--')) {
      fail('CODEX_SANDBOX_CONTROLLER_PAYLOAD_INVALID', `invalid option '${flag}'`, 2);
      return null;
    }
    values[flag] = value;
  }
  return { operation, values };
}

async function codexSandboxController(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('codex-sandbox-controller', args)) return;
  const parsed = parse(args);
  if (!parsed || process.exitCode) return;
  try {
    if (parsed.operation === 'verify-context') {
      const contextPath = parsed.values['--context']
        ?? process.env.AGENT_INFRA_CODEX_CONTROLLER_CONTEXT;
      if (!contextPath) throw new Error('CODEX_SANDBOX_CONTROLLER_CONTEXT_MISSING');
      const verified = verifyCodexSandboxControllerContextWithWarnings(contextPath);
      const context = verified.context;
      process.stdout.write(`${JSON.stringify({
        status: 'ready',
        changed: false,
        context: {
          taskId: context.taskId,
          controlGeneration: context.controlGeneration,
          controllerInstanceDigest: context.controllerInstanceDigest,
          expiresAt: context.expiresAt,
          buildIdentity: context.buildIdentity,
          hookDefinitionHash: context.hookDefinitionHash,
        },
        ...(verified.warnings.length > 0 ? { warnings: verified.warnings } : {}),
        error: null
      })}\n`);
      return;
    }
    const policy = [
      '--executor-model',
      '--executor-reasoning-effort',
      '--reviewer-model',
      '--reviewer-reasoning-effort'
    ];
    if (policy.some((flag) => parsed.values[flag] !== undefined)
      && policy.some((flag) => parsed.values[flag] === undefined)) {
      throw new Error('CODEX_SANDBOX_CONTROLLER_MODEL_POLICY_INVALID');
    }
    const exitCode = await runCodexSandboxController({
      executorModel: parsed.values['--executor-model'],
      executorReasoningEffort: parsed.values['--executor-reasoning-effort'],
      reviewerModel: parsed.values['--reviewer-model'],
      reviewerReasoningEffort: parsed.values['--reviewer-reasoning-effort']
    });
    process.exitCode = exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+)/u.exec(message)?.[1]
      ?? 'CODEX_SANDBOX_CONTROLLER_FAILED';
    fail(code, message);
  }
}

export { codexSandboxController };
