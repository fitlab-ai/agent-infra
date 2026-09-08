import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HostControlCommandPayload, HostControlRequest } from './client.ts';
import { readHostControlWorkerToken, resolveHostControlEndpoint } from './path.ts';

type HostCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

function payloadFor(request: HostControlRequest): HostControlCommandPayload {
  if (request.scope !== 'host-command' || !request.payload) {
    throw new Error('HOST_CONTROL_REQUEST_INVALID');
  }
  return request.payload as HostControlCommandPayload;
}

export async function dispatchHostControlCommand(request: HostControlRequest): Promise<HostCommandResult> {
  const payload = payloadFor(request);
  const compiledEntry = fileURLToPath(new URL('../../bin/internal-cli.js', import.meta.url));
  const sourceEntry = fileURLToPath(new URL('../../bin/internal-cli.ts', import.meta.url));
  const entry = fs.existsSync(compiledEntry) ? compiledEntry : sourceEntry;
  const payloadEnvironment = payload.environment ?? {};
  const env = { ...process.env, ...payloadEnvironment };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENT_INFRA_CONTROL_')
      || key === 'AGENT_INFRA_TASK_ID'
      || key === 'AGENT_INFRA_RUNTIME_DIR'
      || key === 'AGENT_INFRA_EXECUTOR_MANIFEST'
      || key === 'AGENT_INFRA_HOST_CONTROL_SOCKET') {
      delete env[key];
    }
  }
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.AGENT_INFRA_HOST_CONTROL_WORKER;
  delete env.AGENT_INFRA_HOST_CONTROL_WORKER_TOKEN;
  env.AGENT_INFRA_HOST_CONTROL_WORKER = '1';
  env.AGENT_INFRA_HOST_CONTROL_WORKER_TOKEN = readHostControlWorkerToken(
    process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT ?? resolveHostControlEndpoint()
  );

  return await new Promise<HostCommandResult>((resolve, reject) => {
    const runtimeArgs = entry.endsWith('.ts') ? ['--experimental-strip-types', '--no-warnings', entry] : [entry];
    const child = spawn(process.execPath, [...runtimeArgs, request.operation, ...payload.args], {
      cwd: payload.workingDirectory,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`HOST_CONTROL_WORKER_TERMINATED: ${signal}`));
      else resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
