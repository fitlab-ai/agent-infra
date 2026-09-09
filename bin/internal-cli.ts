#!/usr/bin/env node

import { classifySandboxControlEnvironment } from '../lib/sandbox/control/client.ts';
import {
  formatTaskViewDiagnostic,
  guardTaskOperation,
  resolveSandboxControlTransport,
  TaskViewOperationError
} from '../lib/internal/task-operation-registry.ts';
import { INTERNAL_HANDLER_ROUTE_SELECTORS } from '../lib/internal/cli-route-inventory.ts';
import {
  hostControlRequestForCommand,
  requestHostControl,
  HostControlClientError,
  HOST_CONTROL_TEST_ENVIRONMENT_KEYS,
  type HostControlCommand
} from '../lib/host-control/client.ts';
import { resolveHostControlEndpoint, readHostControlWorkerToken } from '../lib/host-control/path.ts';
const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => parseInt(part, 10));
if (major < 22 || (major === 22 && minor < 9)) {
  process.stderr.write(
    `agent-infra-internal requires Node.js >= 22.9.0 (current: ${process.version})\n`
  );
  process.exit(1);
}

const command = process.argv[2] || '';
const internalRouteRegistered = Object.hasOwn(INTERNAL_HANDLER_ROUTE_SELECTORS, command);
const taskControlCommand = command === 'task-lifecycle' || command === 'task-orchestration' || command === 'task-finalization';
const taskWorkflowCommand = command === 'task-artifact'
  || command === 'task-review'
  || command === 'task-event'
  || command === 'task-ledger'
  || command === 'task-invalidation'
  || command === 'task-warning';
const localTaskControlHelp = taskControlCommand
  && (process.argv[3] === '--help' || process.argv[3] === '-h')
  && !process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT;

let taskViewGuardFailed = false;
try {
  const guard = guardTaskOperation('internal', command, process.argv.slice(3));
  if (guard.taskView && guard.descriptor.effect === 'diagnostic') {
    process.stderr.write(formatTaskViewDiagnostic(guard.taskView));
  }
} catch (error) {
  taskViewGuardFailed = true;
  if (error instanceof TaskViewOperationError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}

function taskControlTransportFailure(message: string, code = 'TASK_CONTROL_TRANSPORT_INVALID'): never {
  process.stdout.write(`${JSON.stringify({
    status: 'failed', changed: false,
    error: { code, message }
  })}\n`);
  process.exit(1);
}

async function runHostControlCommand(commandName: HostControlCommand, args: string[]): Promise<void> {
  let response;
  try {
    const testEndpoint = process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT;
    const forwardedEnvironment = testEndpoint
      ? Object.fromEntries(HOST_CONTROL_TEST_ENVIRONMENT_KEYS.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
      : {};
    response = await requestHostControl({
      request: hostControlRequestForCommand(commandName, args, process.cwd(), forwardedEnvironment),
      endpoint: process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT ?? resolveHostControlEndpoint()
    });
  } catch (error) {
    if (error instanceof HostControlClientError) {
      taskControlTransportFailure('host-control service is unavailable', 'SANDBOX_CONTROL_HOST_AUTHORITY_UNAVAILABLE');
    }
    throw error;
  }
  if (response.status === 'rejected') {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: response.error })}\n`);
    process.exitCode = response.exitCode;
    return;
  }
  const result = response.result;
  if (result && typeof result === 'object' && 'stdout' in result && typeof result.stdout === 'string') {
    const commandResult = result as { stdout: string; stderr?: unknown; exitCode?: unknown };
    process.stdout.write(commandResult.stdout);
    if (typeof commandResult.stderr === 'string') process.stderr.write(commandResult.stderr);
    if (Number.isSafeInteger(commandResult.exitCode)) process.exitCode = commandResult.exitCode as number;
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const hostWorkerRequested = process.env.AGENT_INFRA_HOST_CONTROL_WORKER === '1';
const hostWorker = hostWorkerRequested && (() => {
  try {
    const endpoint = process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT ?? resolveHostControlEndpoint();
    return process.env.AGENT_INFRA_HOST_CONTROL_WORKER_TOKEN === readHostControlWorkerToken(endpoint);
  } catch {
    return false;
  }
})();
if (hostWorkerRequested && !hostWorker && (taskControlCommand || taskWorkflowCommand)) {
  taskControlTransportFailure('host-control worker authorization is invalid', 'SANDBOX_CONTROL_HOST_AUTHORITY_UNAVAILABLE');
}
let hostControlRouted = false;

if (taskControlCommand && !hostWorker && !localTaskControlHelp) {
  const transport = resolveSandboxControlTransport(process.env);
  if (transport.kind === 'fail-closed') {
    const reasonCode = transport.reasonCode ?? 'TASK_CONTROL_TRANSPORT_INVALID';
    taskControlTransportFailure(reasonCode, reasonCode.startsWith('SANDBOX_CONTROL_IDENTITY_') ? reasonCode : undefined);
  }
  if (transport.kind === 'direct-host' && !localTaskControlHelp) {
    await runHostControlCommand(command as HostControlCommand, process.argv.slice(3));
    hostControlRouted = true;
  }
}

let taskWorkflowBrokerClient = false;
if (taskWorkflowCommand && !hostWorker) {
  const transport = resolveSandboxControlTransport(process.env);
  if (transport.kind === 'fail-closed') {
    taskControlTransportFailure(transport.reasonCode ?? 'SANDBOX_CONTROL_TRANSPORT_INVALID');
  }
  if (transport.kind === 'direct-host') {
    await runHostControlCommand(command as HostControlCommand, process.argv.slice(3));
    hostControlRouted = true;
  }
  taskWorkflowBrokerClient = transport.kind === 'broker-client';
}

if (!hostControlRouted && !taskViewGuardFailed && taskControlCommand) {
  const environment = classifySandboxControlEnvironment();
  if (environment.kind === 'invalid') {
    taskControlTransportFailure(environment.message ?? 'sandbox client control configuration is invalid');
  }
  if (environment.kind === 'controlled') {
    const { sandboxControl } = await import('../lib/internal/sandbox-control.ts');
    await sandboxControl(['client', command, ...process.argv.slice(3)]);
  } else {
    switch (command) {
      case 'task-orchestration': {
        const { taskOrchestration } = await import('../lib/internal/task-orchestration.ts');
        await taskOrchestration(process.argv.slice(3));
        break;
      }
      case 'task-lifecycle': {
        const { taskLifecycle } = await import('../lib/internal/task-lifecycle.ts');
        await taskLifecycle(process.argv.slice(3));
        break;
      }
      case 'task-finalization': {
        const { taskFinalization } = await import('../lib/internal/task-finalization.ts');
        await taskFinalization(process.argv.slice(3));
        break;
      }
    }
  }
} else if (!hostControlRouted && !taskViewGuardFailed && taskWorkflowBrokerClient) {
  const { sandboxControl } = await import('../lib/internal/sandbox-control.ts');
  await sandboxControl(['client', 'task-workflow', command, ...process.argv.slice(3)]);
} else if (!hostControlRouted && !taskViewGuardFailed && internalRouteRegistered) switch (command) {

  case 'task-create': {
    const { taskCreate } = await import('../lib/internal/task-create.ts');
    await taskCreate(process.argv.slice(3));
    break;
  }

  case 'sandbox-control': {
    const { sandboxControl } = await import('../lib/internal/sandbox-control.ts');
    await sandboxControl(process.argv.slice(3));
    break;
  }
  case 'host-control': {
    const { hostControl } = await import('../lib/internal/host-control.ts');
    await hostControl(process.argv.slice(3));
    break;
  }
  case 'agent-client': {
    const { agentClient } = await import('../lib/internal/agent-client.ts');
    agentClient(process.argv.slice(3));
    break;
  }
  case 'codex-lifecycle': {
    const { codexLifecycle } = await import('../lib/internal/codex-lifecycle.ts');
    await codexLifecycle(process.argv.slice(3));
    break;
  }
  case 'codex-sandbox-controller': {
    const { codexSandboxController } = await import('../lib/internal/codex-sandbox-controller.ts');
    await codexSandboxController(process.argv.slice(3));
    break;
  }
  case 'git-workflow': {
    const { gitWorkflow } = await import('../lib/internal/git-workflow.ts');
    gitWorkflow(process.argv.slice(3));
    break;
  }
  case 'task-delivery': {
    const { taskDelivery } = await import('../lib/internal/task-delivery.ts');
    taskDelivery(process.argv.slice(3));
    break;
  }
  case 'release-workflow': {
    const { releaseWorkflow } = await import('../lib/internal/release-workflow.ts');
    await releaseWorkflow(process.argv.slice(3));
    break;
  }
  case 'platform-release-notes': {
    const { platformReleaseNotes } = await import('../lib/internal/platform-release-notes.ts');
    await platformReleaseNotes(process.argv.slice(3));
    break;
  }
  case 'platform-context': {
    const { platformContext } = await import('../lib/internal/platform-context.ts');
    await platformContext(process.argv.slice(3));
    break;
  }
  case 'platform-comment': {
    const { platformComment } = await import('../lib/internal/platform-comment.ts');
    await platformComment(process.argv.slice(3));
    break;
  }
  case 'platform-issue': {
    const { platformIssue } = await import('../lib/internal/platform-issue.ts');
    await platformIssue(process.argv.slice(3));
    break;
  }
  case 'platform-pr': {
    const { platformPr } = await import('../lib/internal/platform-pr.ts');
    await platformPr(process.argv.slice(3));
    break;
  }
  case 'platform-pr-review': {
    const { platformPrReview } = await import('../lib/internal/platform-pr-review.ts');
    await platformPrReview(process.argv.slice(3));
    break;
  }
  case 'pr-review-grade': {
    const { prReviewGrade } = await import('../lib/internal/pr-review-grade.ts');
    await prReviewGrade(process.argv.slice(3));
    break;
  }
  case 'platform-checks': {
    const { platformChecks } = await import('../lib/internal/platform-checks.ts');
    await platformChecks(process.argv.slice(3));
    break;
  }
  case 'platform-security': {
    const { platformSecurity } = await import('../lib/internal/platform-security.ts');
    await platformSecurity(process.argv.slice(3));
    break;
  }
  case 'platform-metadata': {
    const { platformMetadata } = await import('../lib/internal/platform-metadata.ts');
    await platformMetadata(process.argv.slice(3));
    break;
  }
  case 'task-context': {
    const { taskContext } = await import('../lib/internal/task-context.ts');
    taskContext(process.argv.slice(3));
    break;
  }
  case 'task-ledger': {
    const { taskLedger } = await import('../lib/internal/task-ledger.ts');
    await taskLedger(process.argv.slice(3));
    break;
  }
  case 'task-qualification': {
    const { taskQualification } = await import('../lib/internal/task-qualification.ts');
    await taskQualification(process.argv.slice(3));
    break;
  }
  case 'task-warning': {
    const { taskWarning } = await import('../lib/internal/task-warning.ts');
    await taskWarning(process.argv.slice(3));
    break;
  }
  case 'task-activity': {
    const { taskActivity } = await import('../lib/internal/task-activity.ts');
    await taskActivity(process.argv.slice(3));
    break;
  }
  case 'task-artifact': {
    const { taskArtifact } = await import('../lib/internal/task-artifact.ts');
    taskArtifact(process.argv.slice(3));
    break;
  }
  case 'task-orchestration': {
    const { taskOrchestration } = await import('../lib/internal/task-orchestration.ts');
    await taskOrchestration(process.argv.slice(3));
    break;
  }
  case 'task-review': {
    const { taskReview } = await import('../lib/internal/task-review.ts');
    await taskReview(process.argv.slice(3));
    break;
  }
  case 'task-event': {
    const { taskEvent } = await import('../lib/internal/task-event.ts');
    await taskEvent(process.argv.slice(3));
    break;
  }
  case 'task-invalidation': {
    const { taskInvalidation } = await import('../lib/internal/task-invalidation.ts');
    taskInvalidation(process.argv.slice(3));
    break;
  }
  case 'task-lifecycle': {
    const { taskLifecycle } = await import('../lib/internal/task-lifecycle.ts');
    await taskLifecycle(process.argv.slice(3));
    break;
  }
  case 'task-finalization': {
    const { taskFinalization } = await import('../lib/internal/task-finalization.ts');
    await taskFinalization(process.argv.slice(3));
    break;
  }
  case 'task-override': {
    const { taskOverride } = await import('../lib/internal/task-override.ts');
    await taskOverride(process.argv.slice(3));
    break;
  }
  case 'task-short-id': {
    const { taskShortId } = await import('../lib/internal/task-short-id.ts');
    taskShortId(process.argv.slice(3));
    break;
  }
  case 'task-snapshot': {
    const { taskSnapshot } = await import('../lib/internal/task-snapshot.ts');
    taskSnapshot(process.argv.slice(3));
    break;
  }
  case 'task-verify': {
    const { taskVerify } = await import('../lib/internal/task-verify.ts');
    await taskVerify(process.argv.slice(3));
    break;
  }
  case 'task-validate': {
    const { taskValidate } = await import('../lib/internal/task-validate.ts');
    taskValidate(process.argv.slice(3));
    break;
  }
  default:
    process.stdout.write(`${JSON.stringify({
      status: 'failed',
      changed: false,
      error: { code: 'INTERNAL_COMMAND_INVALID', message: `unknown internal command '${command}'` }
    })}\n`);
    process.exitCode = 1;
}
