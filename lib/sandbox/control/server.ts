import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getProcessStartTime } from '../../server/process-state.ts';
import { createTask } from '../../task/create-service.ts';
import {
  bindSandboxControlTask,
  validateSandboxControlRequest,
  type SandboxControlManifest,
  type SandboxControlResponse
} from './protocol.ts';

function readManifest(manifestPath: string): SandboxControlManifest {
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SandboxControlManifest;
  if (
    manifest.version !== 1
    || typeof manifest.repoRoot !== 'string'
    || typeof manifest.channelDir !== 'string'
    || typeof manifest.token !== 'string'
  ) throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  if (path.resolve(manifest.channelDir) !== path.join(path.dirname(path.resolve(manifestPath)), 'channel')) {
    throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  }
  return manifest;
}

function assertRealDirectory(directory: string, parent?: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  if (parent && path.dirname(fs.realpathSync.native(directory)) !== fs.realpathSync.native(parent)) {
    throw new Error('SANDBOX_CONTROL_CHANNEL_INVALID');
  }
}

function writeResponse(directory: string, response: SandboxControlResponse): void {
  const temporary = path.join(directory, `.${response.id}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(response)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, path.join(directory, `${response.id}.json`));
}

export function sandboxControlSafeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !key.toUpperCase().startsWith('AGENT_INFRA_CONTROL_')
    )
  );
}

function consumeRequest(directory: string, id: string): void {
  try {
    fs.writeFileSync(path.join(directory, id), '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('SANDBOX_CONTROL_REQUEST_REPLAYED');
    }
    throw error;
  }
}

export function serveSandboxControl(manifestPath: string, signal: AbortSignal = new AbortController().signal): void {
  const manifest = readManifest(manifestPath);
  const brokerPath = path.join(path.dirname(manifestPath), 'broker.json');
  const startTime = getProcessStartTime(process.pid);
  if (!startTime) throw new Error('SANDBOX_CONTROL_BROKER_IDENTITY_UNAVAILABLE');
  fs.writeFileSync(brokerPath, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    startTime,
    token: manifest.token
  })}\n`, { mode: 0o600, flag: 'wx' });
  const requestsDir = path.join(manifest.channelDir, 'requests');
  const responsesDir = path.join(manifest.channelDir, 'responses');
  const consumedDir = path.join(path.dirname(manifestPath), 'consumed');
  assertRealDirectory(manifest.channelDir);
  fs.mkdirSync(requestsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(responsesDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(consumedDir, { recursive: true, mode: 0o700 });
  assertRealDirectory(requestsDir, manifest.channelDir);
  assertRealDirectory(responsesDir, manifest.channelDir);
  assertRealDirectory(consumedDir, path.dirname(manifestPath));
  while (!signal.aborted) {
    const current = readManifest(manifestPath);
    if (current.token !== manifest.token) return;
    assertRealDirectory(requestsDir, manifest.channelDir);
    assertRealDirectory(responsesDir, manifest.channelDir);
    for (const name of fs.readdirSync(requestsDir).sort()) {
      if (!/^[a-f0-9-]{16,64}\.json$/.test(name)) continue;
      const requestPath = path.join(requestsDir, name);
      let id = name.slice(0, -5);
      let response: SandboxControlResponse;
      try {
        const stat = fs.lstatSync(requestPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_REQUEST_INVALID');
        const request = validateSandboxControlRequest(
          JSON.parse(fs.readFileSync(requestPath, 'utf8')),
          manifest
        );
        id = request.id;
        consumeRequest(consumedDir, id);
        if (request.family === 'task-create') {
          const result = createTask(request.candidate, { repoRoot: manifest.repoRoot });
          response = {
            version: 1, id,
            exitCode: result.status === 'blocked' ? 2 : result.status === 'failed' ? 1 : 0,
            stdout: `${JSON.stringify(result)}\n`, stderr: ''
          };
        } else {
          const result = spawnSync(
            process.execPath,
            ['--experimental-strip-types', '--no-warnings', process.argv[1]!, request.family, ...bindSandboxControlTask(request, manifest.taskId!)],
            {
              cwd: manifest.repoRoot,
              encoding: 'utf8',
              env: sandboxControlSafeEnv()
            }
          );
          response = {
            version: 1,
            id,
            exitCode: result.status ?? 1,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? ''
          };
        }
      } catch (error) {
        response = {
          version: 1,
          id,
          exitCode: 1,
          stdout: '',
          stderr: `${error instanceof Error ? error.message : String(error)}\n`
        };
      }
      try {
        fs.unlinkSync(requestPath);
        writeResponse(responsesDir, response);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}
