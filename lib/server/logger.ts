import fs from 'node:fs';
import path from 'node:path';

export type LoggerOptions = {
  path: string;
  rotateAtBytes: number;
};

export type Logger = {
  info: (message: string) => void;
  ok: (message: string) => void;
  err: (message: string) => void;
  close: () => void;
};

// Startup-only rotation: if the existing log already exceeds the threshold,
// move it aside to `<path>.1` before the daemon starts appending. We do not
// rotate again while running — keeping a single append stream is simpler and
// good enough for a local daemon log.
function rotateIfOversized(logPath: string, rotateAtBytes: number): void {
  try {
    const { size } = fs.statSync(logPath);
    if (size > rotateAtBytes) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // No existing log file (or stat failed) → nothing to rotate.
  }
}

export function createLogger({ path: logPath, rotateAtBytes }: LoggerOptions): Logger {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  rotateIfOversized(logPath, rotateAtBytes);

  const write = (level: string, message: string): void => {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    fs.appendFileSync(logPath, line);
  };

  return {
    info: (message) => write('INFO', message),
    ok: (message) => write('OK', message),
    err: (message) => write('ERROR', message),
    // Synchronous appendFileSync keeps no open handle to flush; close() exists
    // so the daemon shutdown path has a single, stable hook to call.
    close: () => {}
  };
}
