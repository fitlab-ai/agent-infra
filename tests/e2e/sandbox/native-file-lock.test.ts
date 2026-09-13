import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { acquireSandboxResourceLock } from '../../../lib/sandbox/control/native-file-lock.ts';
import { filePath } from '../../helpers.ts';

for (const termination of ['release', 'kill'] as const) {
  test(`native lock excludes other processes and recovers after ${termination}`, { timeout: 15_000 }, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lock-process-'));
    const moduleUrl = pathToFileURL(filePath('dist/lib/sandbox/control/native-file-lock.js')).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      const { acquireSandboxResourceLock } = await import(process.argv[1]);
      const lock = acquireSandboxResourceLock('process-lock', { home: process.argv[2] });
      process.on('message', () => {
        lock.release();
        process.disconnect();
      });
      process.send('locked');
    `, moduleUrl, home], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => { stderr += error.message; });
    const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once('close', (code, signal) => resolve([code, signal]));
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      fs.rmSync(home, { recursive: true, force: true });
    });

    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]) }),
      closed.then(() => { throw new Error(`Lock holder exited before acquiring the lock: ${stderr}`); })
    ]);
    assert.equal(message, 'locked', stderr);
    assert.throws(() => acquireSandboxResourceLock('process-lock', { home }), /SANDBOX_LOCK_BUSY/);
    acquireSandboxResourceLock('independent-resource', { home }).release();

    if (termination === 'kill') child.kill('SIGKILL');
    else child.send('release');
    const [code, signal] = await closed;
    if (termination === 'release') assert.equal(code, 0, stderr);
    else assert.equal(signal, 'SIGKILL', stderr);

    const recovered = acquireSandboxResourceLock('process-lock', { home });
    recovered.release();
    recovered.release();
    assert.equal(fs.existsSync(recovered.path), true);
  });
}
