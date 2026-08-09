import { requestSandboxControl } from '../sandbox/control/client.ts';
import { serveSandboxControl } from '../sandbox/control/server.ts';

function sandboxControl(args: string[]): void {
  const [operation, ...rest] = args;
  if (operation === 'serve') {
    const manifestIndex = rest.indexOf('--manifest');
    const manifest = manifestIndex >= 0 ? rest[manifestIndex + 1] : undefined;
    if (!manifest) throw new Error('sandbox-control serve requires --manifest');
    serveSandboxControl(manifest);
    return;
  }
  if (operation === 'client') {
    const [family = '', ...commandArgs] = rest;
    const response = requestSandboxControl({ family, args: commandArgs });
    process.stdout.write(response.stdout);
    process.stderr.write(response.stderr);
    process.exitCode = response.exitCode;
    return;
  }
  throw new Error('Usage: agent-infra-internal sandbox-control serve --manifest <path> | client <family> [args...]');
}

export { sandboxControl };
