import { StringDecoder } from 'node:string_decoder';
import { spawnSync } from 'node:child_process';
import { createClipboardAdapter, type ClipboardAdapter } from './index.ts';
import { buildBracketedPaste, CtrlVDetector, type CtrlVMatch } from './keys.ts';
import {
  clipboardHostDir,
  containerClipboardPath,
  pngClipboardFilename,
  pruneClipboardDir,
  writeClipboardPngAtomic
} from './paths.ts';
import { commandForEngine, restoreTerminal, runInteractiveEngine, runOkEngine } from '../shell.ts';
import { loadNodePty, type NodePty, type PtyProcess } from './node-pty.ts';

type BridgeOptions = {
  engine: string;
  dockerArgs: string[];
  container: string;
  home: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platformName?: NodeJS.Platform;
  adapter?: ClipboardAdapter | null;
  loadPty?: () => Promise<NodePty | null>;
  runInteractive?: typeof runInteractiveEngine;
  runOk?: typeof runOkEngine;
  writeStderr?: (chunk: string) => unknown;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  createDetector?: () => CtrlVDetector;
};

const FALLBACK_PREFIX = 'Warning: clipboard image paste bridge disabled';
const PARTIAL_ESCAPE_FLUSH_MS = 30;

// Node's stdin.setRawMode(true) uses libuv's RAW mode, which (unlike the
// cfmakeraw that `docker exec -it` applies on the non-bridge path) keeps ONLCR
// set on the shared host TTY. With ONLCR on, the kernel rewrites the bare \n
// that tmux emits after homing the cursor inside the right pane into \r\n,
// snapping the cursor to column 1 so the following erase/redraw wipes the left
// pane. Clearing OPOST brings the host TTY in line with the non-bridge path.
// Best-effort: setRawMode(false) on teardown restores the original termios, and
// a missing/failed stty only reinstates the redraw glitch.
function disableOutputPostProcessing(stdin: NodeJS.ReadStream): void {
  const candidate = (stdin as { fd?: unknown }).fd;
  if (typeof candidate !== 'number') {
    return;
  }
  try {
    spawnSync('stty', ['-opost'], { stdio: [candidate, 'ignore', 'ignore'] });
  } catch {
    // stty unavailable or fd is not a tty; leave the terminal as-is.
  }
}

export async function runInteractiveWithClipboardBridge(options: BridgeOptions): Promise<number> {
  const {
    engine,
    dockerArgs,
    container,
    home,
    cwd = process.cwd(),
    env = process.env,
    platformName = process.platform,
    adapter = createClipboardAdapter({ platformName }),
    loadPty = loadNodePty,
    runInteractive = runInteractiveEngine,
    runOk = runOkEngine,
    writeStderr = (chunk) => process.stderr.write(chunk),
    stdin = process.stdin,
    stdout = process.stdout,
    createDetector = () => new CtrlVDetector()
  } = options;

  function fallback(reason: string): number {
    writeStderr(`${FALLBACK_PREFIX}: ${reason}\n`);
    return runInteractive(engine, 'docker', dockerArgs);
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    return fallback('host stdin/stdout is not a TTY');
  }
  if (!adapter) {
    return fallback('no clipboard adapter available on this platform');
  }
  const available = adapter.available();
  if (!available.ok) {
    return fallback(available.reason);
  }
  if (!runOk(engine, 'docker', ['exec', container, 'sh', '-c', '[ -d /clipboard ] && [ -r /clipboard ]'])) {
    return fallback('container /clipboard mount is missing; rebuild the sandbox to enable image paste');
  }

  const pty = await loadPty();
  if (!pty) {
    return fallback('node-pty optional dependency is unavailable');
  }

  const command = commandForEngine(engine, 'docker', dockerArgs);
  let child: PtyProcess;
  try {
    child = pty.spawn(command.cmd, command.args, {
      name: env.TERM || 'xterm-256color',
      cols: stdout.columns || 120,
      rows: stdout.rows || 40,
      cwd,
      env
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return fallback(`node-pty spawn failed: ${message}`);
  }

  return runBridge({
    child,
    home,
    adapter,
    writeStderr,
    stdin,
    stdout,
    detector: createDetector()
  });
}

async function runBridge({
  child,
  home,
  adapter,
  writeStderr,
  stdin,
  stdout,
  detector
}: {
  child: PtyProcess;
  home: string;
  adapter: ClipboardAdapter;
  writeStderr: (chunk: string) => unknown;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  detector: CtrlVDetector;
}): Promise<number> {
  let warnedPasteFailure = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const inputDecoder = new StringDecoder('utf8');

  const onData = (chunk: Buffer) => {
    clearFlushTimer();
    for (const token of detector.feed(inputDecoder.write(chunk))) {
      if (token.kind === 'text') {
        child.write(token.raw);
      } else {
        handleCtrlV(token, child);
      }
    }
    if (detector.hasPending()) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        for (const token of detector.flush()) {
          if (token.kind === 'text') {
            child.write(token.raw);
          } else {
            handleCtrlV(token, child);
          }
        }
      }, PARTIAL_ESCAPE_FLUSH_MS);
    }
  };
  const onResize = () => child.resize(stdout.columns || 120, stdout.rows || 40);
  const onSigint = () => child.kill('SIGINT');
  const onSigterm = () => child.kill('SIGTERM');

  function handleCtrlV(match: CtrlVMatch, target: PtyProcess): void {
    try {
      // readImagePng returns null both for "no image on clipboard" and for
      // unexpected read failures; both cases forward the original Ctrl+V so
      // the container app handles it as a regular keystroke. The throw branch
      // below only fires on truly unexpected exceptions (e.g. fs write
      // errors writing to the host clipboard dir).
      const png = adapter.readImagePng();
      if (!png) {
        target.write(match.raw);
        return;
      }
      const filename = pngClipboardFilename(png);
      writeClipboardPngAtomic(clipboardHostDir(home), filename, png);
      pruneClipboardDir(clipboardHostDir(home));
      target.write(buildBracketedPaste(containerClipboardPath(filename)));
    } catch (error) {
      target.write(match.raw);
      if (!warnedPasteFailure) {
        warnedPasteFailure = true;
        writeStderr(`Warning: clipboard image paste failed; forwarded original Ctrl+V (${error instanceof Error ? error.message : 'unknown error'})\n`);
      }
    }
  }

  function clearFlushTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  try {
    stdin.setRawMode?.(true);
    disableOutputPostProcessing(stdin);
    stdin.resume();
    stdin.on('data', onData);
    stdout.on('resize', onResize);
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    child.onData((data) => stdout.write(data));

    return exitCode(await onceExit(child, stdin));
  } finally {
    clearFlushTimer();
    // The child pty is already exiting here; flushing buffered input is
    // best-effort and must never block terminal/stdin cleanup below.
    try {
      for (const token of detector.feed(inputDecoder.end())) {
        if (token.kind === 'text') {
          child.write(token.raw);
        } else {
          handleCtrlV(token, child);
        }
      }
      for (const token of detector.flush()) {
        if (token.kind === 'text') {
          child.write(token.raw);
        }
      }
    } catch {
      // Writing to an already-closed pty can throw; ignore on teardown.
    }
    stdin.off('data', onData);
    stdout.off('resize', onResize);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    stdin.setRawMode?.(false);
    // Release stdin so the resumed TTY handle stops keeping the event loop
    // alive; without this the CLI hangs after the sandbox exits until Ctrl+C.
    stdin.pause?.();
    restoreTerminal();
  }
}

function onceExit(
  child: PtyProcess,
  stdin: NodeJS.ReadStream
): Promise<{ exitCode: number; signal?: number | string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (event: { exitCode: number; signal?: number | string }) => {
      if (settled) {
        return;
      }
      settled = true;
      stdin.off('end', onStdinEnd);
      stdin.off('close', onStdinEnd);
      resolve(event);
    };
    const onStdinEnd = () => {
      child.kill('SIGHUP');
      finish({ exitCode: 0, signal: 'SIGHUP' });
    };

    child.onExit(finish);
    stdin.once('end', onStdinEnd);
    stdin.once('close', onStdinEnd);
  });
}

function exitCode(event: { exitCode: number; signal?: number | string }): number {
  if (event.signal !== undefined && event.signal !== null) {
    return signalExitCode(event.signal);
  }
  if (event.exitCode !== undefined && event.exitCode !== null) {
    return event.exitCode;
  }
  return 1;
}

function signalExitCode(signal: number | string): number {
  if (typeof signal === 'number') {
    return 128 + signal;
  }
  const signals: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15
  };
  return 128 + (signals[signal] ?? 0);
}
