import { createRequire } from 'node:module';

export type PtyProcess = {
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number | string }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

export type NodePty = {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    }
  ): PtyProcess;
};

export async function loadNodePty(): Promise<NodePty | null> {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('@lydell/node-pty') as NodePty | { default?: NodePty };
    const maybeDefault = mod as { default?: NodePty };
    return maybeDefault.default ?? (mod as NodePty);
  } catch {
    return null;
  }
}
