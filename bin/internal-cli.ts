#!/usr/bin/env node

const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => parseInt(part, 10));
if (major < 22 || (major === 22 && minor < 9)) {
  process.stderr.write(
    `agent-infra-internal requires Node.js >= 22.9.0 (current: ${process.version})\n`
  );
  process.exit(1);
}

const command = process.argv[2] || '';

if (
  process.env.AGENT_INFRA_CONTROL_TOKEN
  && (command === 'task-lifecycle' || command === 'task-orchestration' || command === 'task-finalization')
) {
  const { sandboxControl } = await import('../lib/internal/sandbox-control.ts');
  await sandboxControl(['client', command, ...process.argv.slice(3)]);
} else switch (command) {

  case 'task-create': {
    const { taskCreate } = await import('../lib/internal/task-create.ts');
    taskCreate(process.argv.slice(3));
    break;
  }

  case 'sandbox-control': {
    const { sandboxControl } = await import('../lib/internal/sandbox-control.ts');
    await sandboxControl(process.argv.slice(3));
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
  case 'release-workflow': {
    const { releaseWorkflow } = await import('../lib/internal/release-workflow.ts');
    await releaseWorkflow(process.argv.slice(3));
    break;
  }
  case 'platform-release-notes': {
    const { platformReleaseNotes } = await import('../lib/internal/platform-release-notes.ts');
    platformReleaseNotes(process.argv.slice(3));
    break;
  }
  case 'platform-context': {
    const { platformContext } = await import('../lib/internal/platform-context.ts');
    platformContext(process.argv.slice(3));
    break;
  }
  case 'platform-comment': {
    const { platformComment } = await import('../lib/internal/platform-comment.ts');
    platformComment(process.argv.slice(3));
    break;
  }
  case 'platform-issue': {
    const { platformIssue } = await import('../lib/internal/platform-issue.ts');
    platformIssue(process.argv.slice(3));
    break;
  }
  case 'platform-pr': {
    const { platformPr } = await import('../lib/internal/platform-pr.ts');
    platformPr(process.argv.slice(3));
    break;
  }
  case 'platform-pr-review': {
    const { platformPrReview } = await import('../lib/internal/platform-pr-review.ts');
    platformPrReview(process.argv.slice(3));
    break;
  }
  case 'pr-review-grade': {
    const { prReviewGrade } = await import('../lib/internal/pr-review-grade.ts');
    prReviewGrade(process.argv.slice(3));
    break;
  }
  case 'platform-checks': {
    const { platformChecks } = await import('../lib/internal/platform-checks.ts');
    await platformChecks(process.argv.slice(3));
    break;
  }
  case 'task-context': {
    const { taskContext } = await import('../lib/internal/task-context.ts');
    taskContext(process.argv.slice(3));
    break;
  }
  case 'task-ledger': {
    const { taskLedger } = await import('../lib/internal/task-ledger.ts');
    taskLedger(process.argv.slice(3));
    break;
  }
  case 'task-warning': {
    const { taskWarning } = await import('../lib/internal/task-warning.ts');
    taskWarning(process.argv.slice(3));
    break;
  }
  case 'task-activity': {
    const { taskActivity } = await import('../lib/internal/task-activity.ts');
    taskActivity(process.argv.slice(3));
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
    taskReview(process.argv.slice(3));
    break;
  }
  case 'task-event': {
    const { taskEvent } = await import('../lib/internal/task-event.ts');
    taskEvent(process.argv.slice(3));
    break;
  }
  case 'task-lifecycle': {
    const { taskLifecycle } = await import('../lib/internal/task-lifecycle.ts');
    taskLifecycle(process.argv.slice(3));
    break;
  }
  case 'task-finalization': {
    const { taskFinalization } = await import('../lib/internal/task-finalization.ts');
    taskFinalization(process.argv.slice(3));
    break;
  }
  case 'task-override': {
    const { taskOverride } = await import('../lib/internal/task-override.ts');
    taskOverride(process.argv.slice(3));
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
    taskVerify(process.argv.slice(3));
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
