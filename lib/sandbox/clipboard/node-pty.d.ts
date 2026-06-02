declare module '@lydell/node-pty' {
  export function spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    }
  ): {
    onData(callback: (data: string) => void): void;
    onExit(callback: (event: { exitCode: number; signal?: number | string }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  };
}
