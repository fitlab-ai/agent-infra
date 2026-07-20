#!/usr/bin/env node

const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => parseInt(part, 10));
if (major < 22 || (major === 22 && minor < 9)) {
  process.stderr.write(
    `agent-infra-internal requires Node.js >= 22.9.0 (current: ${process.version})\n`
  );
  process.exit(1);
}

const command = process.argv[2] || '';

switch (command) {
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
  case 'task-artifact': {
    const { taskArtifact } = await import('../lib/internal/task-artifact.ts');
    taskArtifact(process.argv.slice(3));
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
  default:
    process.stdout.write(`${JSON.stringify({
      status: 'failed',
      changed: false,
      error: { code: 'INTERNAL_COMMAND_INVALID', message: `unknown internal command '${command}'` }
    })}\n`);
    process.exitCode = 1;
}
