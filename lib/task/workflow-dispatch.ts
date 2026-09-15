import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export type WorkflowDispatchResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/**
 * Runs a broker-authorized workflow command in a short-lived host process.
 * The broker has already authenticated the request, manifest, generation,
 * owner, and lease before this function is reached. The child receives no
 * reusable authority credential and executes through the normal direct-host
 * domain handlers.
 */
export async function dispatchWorkflowCommand(
  repoRoot: string,
  command: string,
  args: readonly string[]
): Promise<WorkflowDispatchResult> {
  const compiledEntry = fileURLToPath(new URL('../../bin/internal-cli.js', import.meta.url));
  const sourceEntry = fileURLToPath(new URL('../../bin/internal-cli.ts', import.meta.url));
  const entry = fs.existsSync(compiledEntry) ? compiledEntry : sourceEntry;
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AGENT_INFRA_CONTROL_')
      || key === 'AGENT_INFRA_TASK_ID'
      || key === 'AGENT_INFRA_RUNTIME_DIR'
      || key === 'AGENT_INFRA_EXECUTOR_MANIFEST') delete env[key];
  }
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;

  return await new Promise<WorkflowDispatchResult>((resolve, reject) => {
    const runtimeArgs = entry.endsWith('.ts') ? ['--experimental-strip-types', '--no-warnings', entry] : [entry];
    const child = spawn(process.execPath, [...runtimeArgs, command, ...args], {
      cwd: repoRoot,
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
      if (signal) reject(new Error(`TASK_WORKFLOW_EXECUTOR_TERMINATED: ${signal}`));
      else resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
