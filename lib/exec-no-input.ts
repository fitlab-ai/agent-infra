import { spawnSync } from 'node:child_process';
import type { ExecFileSyncOptions, ExecFileSyncOptionsWithBufferEncoding, ExecFileSyncOptionsWithStringEncoding, SpawnSyncOptions } from 'node:child_process';

export function execNoInput(file: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function execNoInput(file: string, args: readonly string[], options?: ExecFileSyncOptionsWithBufferEncoding): Buffer;
export function execNoInput(file: string, args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
export function execNoInput(file: string, args: readonly string[], options: ExecFileSyncOptions = {}): string | Buffer {
  const result = spawnSync(file, [...args], {
    ...options,
    encoding: options.encoding === 'buffer' ? null : options.encoding,
    stdio: ['ignore', 'pipe', 'pipe']
  } as SpawnSyncOptions);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    const error = result.error ?? new Error(`Command failed: ${file} ${args.join(' ')}\n${result.stderr ?? ''}`);
    Object.assign(error, { status: result.status, signal: result.signal, output: result.output, pid: result.pid, stdout: result.stdout, stderr: result.stderr });
    throw error;
  }
  return result.stdout;
}
