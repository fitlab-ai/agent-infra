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
  default:
    process.stdout.write(`${JSON.stringify({
      status: 'failed',
      changed: false,
      error: { code: 'INTERNAL_COMMAND_INVALID', message: `unknown internal command '${command}'` }
    })}\n`);
    process.exitCode = 1;
}
