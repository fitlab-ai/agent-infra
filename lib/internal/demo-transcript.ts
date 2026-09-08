import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadNodePty } from '../sandbox/clipboard/node-pty.ts';

const DEMO_COLUMNS = 128;
const DEMO_ROWS = 40;
const DEMO_TIMEOUT_MS = 30_000;
const CHECKPOINT = '\u001b]9;agent-infra-demo-checkpoint\u0007';
const TREE_CHECKPOINT = '\u001b]9;agent-infra-demo-tree-checkpoint\u0007';
const TEMP_PROJECT_PATTERN = /(^|[\s"'`=])((?:[A-Za-z]:[\\/]|[\\/])(?:[^\\/\s"'`]+[\\/])*agent-infra-demo-project-[^\s"'`]+)/g;

const DEMO_PROJECT_PATH = '/tmp/my-awesome-project';
const DEMO_VISIBLE_COMMANDS = Object.freeze({
  prepare: `rm -rf ${DEMO_PROJECT_PATH} && mkdir -p ${DEMO_PROJECT_PATH} && cd ${DEMO_PROJECT_PATH}`,
  git: 'git init -q && git remote add origin git@github.com:acme-corp/my-awesome-project.git',
  init: 'ai init',
  language: 'en',
  clients: '1,2,3,4',
  tree: 'tree .agents/ .claude/ .opencode/ -L 2 --dirsfirst'
});

type TranscriptSuccess = { status: 'ok'; transcript: string; sha256: string };
type TranscriptFailure = { status: 'failed'; reasonCode: 'DEMO_TRANSCRIPT_UNAVAILABLE' | 'DEMO_TRANSCRIPT_FAILED'; message: string };
type TranscriptResult = TranscriptSuccess | TranscriptFailure;
type TranscriptCollector = (cwd: string) => Promise<TranscriptResult>;

type Cell = string;

function blankRow(): Cell[] {
  return Array.from({ length: DEMO_COLUMNS }, () => ' ');
}

function blankScreen(): Cell[][] {
  return Array.from({ length: DEMO_ROWS }, blankRow);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

class TerminalDisplay {
  private screen = blankScreen();
  private history: string[] = [];
  private cursorX = 0;
  private cursorY = 0;
  private savedCursor: { x: number; y: number } = { x: 0, y: 0 };
  private mainScreen: { screen: Cell[][]; x: number; y: number } | null = null;

  feed(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]!;
      if (character === '\u001b') {
        index = this.escape(value, index);
      } else if (character === '\n') {
        this.lineFeed();
      } else if (character === '\r') {
        this.cursorX = 0;
      } else if (character === '\b') {
        this.cursorX = Math.max(0, this.cursorX - 1);
      } else if (character === '\t') {
        this.cursorX = Math.min(DEMO_COLUMNS - 1, Math.floor(this.cursorX / 8 + 1) * 8);
      } else if (character.charCodeAt(0) < 0x20 || character === '\u007f') {
        continue;
      } else {
        this.print(character);
      }
    }
  }

  render(): string {
    const rendered = [...this.history, ...this.screen.map((row) => row.join(''))]
      .map((line) => line.replace(/\s+$/u, ''))
      .join('\n')
      .replace(/\n+$/u, '');
    return rendered ? `${rendered}\n` : '';
  }

  private print(character: string): void {
    if (this.cursorX >= DEMO_COLUMNS) {
      this.cursorX = 0;
      this.lineFeed();
    }
    this.screen[this.cursorY]![this.cursorX] = character;
    this.cursorX += 1;
  }

  private lineFeed(): void {
    if (this.cursorY === DEMO_ROWS - 1) {
      this.history.push(this.screen[0]!.join(''));
      this.screen = [...this.screen.slice(1), blankRow()];
    } else {
      this.cursorY += 1;
    }
  }

  private escape(value: string, index: number): number {
    const next = value[index + 1];
    if (next === '[') return this.csi(value, index + 2);
    if (next === ']') return this.osc(value, index + 2);
    if (next === '7') {
      this.saveCursor();
      return index + 1;
    }
    if (next === '8') {
      this.restoreCursor();
      return index + 1;
    }
    if (next === 'c') {
      this.screen = blankScreen();
      this.history = [];
      this.cursorX = 0;
      this.cursorY = 0;
      return index + 1;
    }
    throw new Error(`Unknown terminal escape sequence at offset ${index}`);
  }

  private osc(value: string, start: number): number {
    for (let index = start; index < value.length; index += 1) {
      if (value[index] === '\u0007') return index;
      if (value[index] === '\u001b' && value[index + 1] === '\\') return index + 1;
    }
    throw new Error(`Unterminated terminal OSC sequence at offset ${start - 2}`);
  }

  private csi(value: string, start: number): number {
    let end = start;
    while (end < value.length && !/[\x40-\x7e]/u.test(value[end]!)) end += 1;
    if (end >= value.length) throw new Error(`Unterminated terminal CSI sequence at offset ${start - 2}`);
    const body = value.slice(start, end);
    const final = value[end]!;
    const privateMode = body.startsWith('?');
    const parameters = (privateMode ? body.slice(1) : body)
      .split(';')
      .map((part) => part === '' ? 0 : Number(part));
    if (parameters.some((parameter) => !Number.isInteger(parameter) || parameter < 0)) {
      throw new Error(`Invalid terminal CSI parameters at offset ${start - 2}`);
    }
    this.applyCsi(final, parameters, privateMode);
    return end;
  }

  private applyCsi(final: string, parameters: number[], privateMode: boolean): void {
    const first = (fallback: number): number => parameters[0] || fallback;
    switch (final) {
      case 'A': this.cursorY = clamp(this.cursorY - first(1), 0, DEMO_ROWS - 1); return;
      case 'B': this.cursorY = clamp(this.cursorY + first(1), 0, DEMO_ROWS - 1); return;
      case 'C': this.cursorX = clamp(this.cursorX + first(1), 0, DEMO_COLUMNS - 1); return;
      case 'D': this.cursorX = clamp(this.cursorX - first(1), 0, DEMO_COLUMNS - 1); return;
      case 'E': this.cursorY = clamp(this.cursorY + first(1), 0, DEMO_ROWS - 1); this.cursorX = 0; return;
      case 'F': this.cursorY = clamp(this.cursorY - first(1), 0, DEMO_ROWS - 1); this.cursorX = 0; return;
      case 'G': this.cursorX = clamp(first(1) - 1, 0, DEMO_COLUMNS - 1); return;
      case 'd': this.cursorY = clamp(first(1) - 1, 0, DEMO_ROWS - 1); return;
      case 'H':
      case 'f':
        this.cursorY = clamp((parameters[0] || 1) - 1, 0, DEMO_ROWS - 1);
        this.cursorX = clamp((parameters[1] || 1) - 1, 0, DEMO_COLUMNS - 1);
        return;
      case 'J': this.eraseDisplay(first(0)); return;
      case 'K': this.eraseLine(first(0)); return;
      case 'P': this.deleteCharacters(first(1)); return;
      case '@': this.insertCharacters(first(1)); return;
      case 'X': this.eraseCharacters(first(1)); return;
      case 'L': this.insertLines(first(1)); return;
      case 'M': this.deleteLines(first(1)); return;
      case 'S': for (let count = 0; count < first(1); count += 1) this.lineFeed(); return;
      case 'T': for (let count = 0; count < first(1); count += 1) this.reverseLineFeed(); return;
      case 's': this.saveCursor(); return;
      case 'u': this.restoreCursor(); return;
      case 'm': return;
      case 'r': return;
      case 'h':
      case 'l':
        if (!privateMode || parameters.some((parameter) => ![25, 1049, 2004].includes(parameter))) {
          throw new Error(`Unknown terminal mode sequence: ${final}`);
        }
        if (parameters.includes(1049)) {
          if (final === 'h') this.enterAlternateScreen();
          else this.leaveAlternateScreen();
        }
        return;
      default:
        throw new Error(`Unknown terminal CSI sequence: ${final}`);
    }
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2) {
      this.screen = blankScreen();
      this.history = [];
      return;
    }
    if (mode === 0) {
      for (let y = this.cursorY; y < DEMO_ROWS; y += 1) {
        const start = y === this.cursorY ? this.cursorX : 0;
        this.screen[y]!.fill(' ', start);
      }
      return;
    }
    if (mode === 1) {
      for (let y = 0; y <= this.cursorY; y += 1) {
        const end = y === this.cursorY ? this.cursorX + 1 : DEMO_COLUMNS;
        this.screen[y]!.fill(' ', 0, end);
      }
      return;
    }
    throw new Error(`Unknown erase-display mode: ${mode}`);
  }

  private eraseLine(mode: number): void {
    if (mode === 0) this.screen[this.cursorY]!.fill(' ', this.cursorX);
    else if (mode === 1) this.screen[this.cursorY]!.fill(' ', 0, this.cursorX + 1);
    else if (mode === 2) this.screen[this.cursorY]!.fill(' ');
    else throw new Error(`Unknown erase-line mode: ${mode}`);
  }

  private deleteCharacters(count: number): void {
    const row = this.screen[this.cursorY]!;
    row.splice(this.cursorX, count);
    row.push(...Array.from({ length: count }, () => ' '));
  }

  private insertCharacters(count: number): void {
    const row = this.screen[this.cursorY]!;
    row.splice(this.cursorX, 0, ...Array.from({ length: count }, () => ' '));
    row.length = DEMO_COLUMNS;
  }

  private eraseCharacters(count: number): void {
    this.screen[this.cursorY]!.fill(' ', this.cursorX, Math.min(DEMO_COLUMNS, this.cursorX + count));
  }

  private insertLines(count: number): void {
    this.screen.splice(this.cursorY, 0, ...Array.from({ length: count }, blankRow));
    this.screen.length = DEMO_ROWS;
  }

  private deleteLines(count: number): void {
    this.screen.splice(this.cursorY, count);
    this.screen.push(...Array.from({ length: count }, blankRow));
    this.screen.length = DEMO_ROWS;
  }

  private reverseLineFeed(): void {
    if (this.cursorY === 0) this.screen.unshift(blankRow());
    else this.cursorY -= 1;
    this.screen.length = DEMO_ROWS;
  }

  private saveCursor(): void {
    this.savedCursor = { x: this.cursorX, y: this.cursorY };
  }

  private restoreCursor(): void {
    this.cursorX = clamp(this.savedCursor.x, 0, DEMO_COLUMNS - 1);
    this.cursorY = clamp(this.savedCursor.y, 0, DEMO_ROWS - 1);
  }

  private enterAlternateScreen(): void {
    if (this.mainScreen) return;
    this.mainScreen = { screen: this.screen, x: this.cursorX, y: this.cursorY };
    this.screen = blankScreen();
    this.history = [];
    this.cursorX = 0;
    this.cursorY = 0;
  }

  private leaveAlternateScreen(): void {
    if (!this.mainScreen) return;
    this.screen = this.mainScreen.screen;
    this.cursorX = this.mainScreen.x;
    this.cursorY = this.mainScreen.y;
    this.mainScreen = null;
  }
}

function normalizeDemoPaths(value: string): string {
  return value.replace(TEMP_PROJECT_PATTERN, '$1/tmp/my-awesome-project');
}

function normalizeVisibleTranscript(value: string): string {
  const display = new TerminalDisplay();
  display.feed(normalizeDemoPaths(value));
  return display.render();
}

function sha256Transcript(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function waitFor(output: () => string, pattern: RegExp, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (pattern.test(output())) { resolve(); return; }
      if (Date.now() >= deadline) { reject(new Error(`Timed out waiting for terminal output matching ${pattern}`)); return; }
      setTimeout(check, 25);
    };
    check();
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function collectDemoTranscript(cwd: string): Promise<TranscriptResult> {
  const ptyModule = await loadNodePty();
  if (!ptyModule) return { status: 'failed', reasonCode: 'DEMO_TRANSCRIPT_UNAVAILABLE', message: '@lydell/node-pty is unavailable' };

  const project = DEMO_PROJECT_PATH;
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-demo-shim-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-demo-home-'));
  const globalGitConfig = path.join(home, 'empty-gitconfig');
  const localCli = path.join(cwd, 'dist', 'bin', 'cli.js');
  const basePath = process.env.PATH ?? '';
  let processHandle: ReturnType<typeof ptyModule.spawn> | null = null;
  let output = '';
  let exited: { exitCode: number; signal?: number | string } | null = null;

  try {
    if (!fs.existsSync(localCli)) throw new Error(`${localCli} not found; run npm run build first`);
    fs.writeFileSync(globalGitConfig, '');
    for (const name of ['ai', 'agent-infra']) {
      const shim = path.join(shimDir, name);
      const checkpoint = name === 'ai' ? `\nprintf '${CHECKPOINT}'\n` : '';
      fs.writeFileSync(shim, `#!/bin/sh\nnode ${JSON.stringify(localCli)} "$@"\nstatus=$?${checkpoint}\nexit $status\n`);
      fs.chmodSync(shim, 0o755);
    }
    const treeShim = path.join(shimDir, 'tree');
    fs.writeFileSync(
      treeShim,
      `#!/bin/sh\nPATH=${shellQuote(basePath)} command tree "$@"\nstatus=$?\nprintf '${TREE_CHECKPOINT}'\nexit $status\n`
    );
    fs.chmodSync(treeShim, 0o755);
    const environment = {
      ...process.env,
      HOME: home,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_GLOBAL: globalGitConfig,
      AGENT_INFRA_DEMO_PLATFORM: 'linux',
      TERM_PROGRAM: '',
      PS1: 'demo$ ',
      PROMPT: 'demo$ ',
      RPS1: '',
      RPROMPT: '',
      PS2: 'demo> ',
      PROMPT2: 'demo> ',
      PS3: 'demo? ',
      PROMPT3: 'demo? ',
      PS4: '+ '
    };
    processHandle = ptyModule.spawn('zsh', ['-f', '-i'], {
      name: 'xterm-256color', cols: DEMO_COLUMNS, rows: DEMO_ROWS, cwd, env: environment
    });
    processHandle.onData((data) => { output += data; });
    processHandle.onExit((event) => { exited = event; });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const send = async (command: string, expected?: RegExp) => {
      processHandle!.write(`${command}\r`);
      if (expected) await waitFor(() => output, expected, DEMO_TIMEOUT_MS);
      else await new Promise((resolve) => setTimeout(resolve, 150));
    };

    await send(DEMO_VISIBLE_COMMANDS.prepare);
    await send(DEMO_VISIBLE_COMMANDS.git);
    await send(DEMO_VISIBLE_COMMANDS.init, /Project name/);
    await send('', /Organization/);
    await send('', /Language/);
    await send(DEMO_VISIBLE_COMMANDS.language, /Sandbox engine/);
    await send('', /Platform/);
    await send('', /Agent Client project integrations/);
    await send(DEMO_VISIBLE_COMMANDS.clients, /Template sources/);
    await send('', /Skill sources/);
    await send('', /(?:initialized|success|created)/i);
    await waitFor(() => output, /agent-infra-demo-checkpoint/, DEMO_TIMEOUT_MS);
    await send(DEMO_VISIBLE_COMMANDS.tree, /agent-infra-demo-tree-checkpoint/);
    processHandle.write('\u0004');
    await waitFor(() => exited ? 'exited' : '', /exited/, 5_000);

    if (!output.includes(CHECKPOINT)) throw new Error('demo transcript checkpoint marker was not emitted');
    if (!output.includes(TREE_CHECKPOINT)) throw new Error('demo transcript tree checkpoint marker was not emitted');
    if (!/\.agents/.test(output)) throw new Error('demo transcript tree checkpoint was not emitted');
    const exitEvent = exited as { exitCode: number; signal?: number | string } | null;
    if (!exitEvent || exitEvent.exitCode !== 0) throw new Error(`demo shell exited with code ${exitEvent?.exitCode ?? 'unknown'}`);
    const transcript = normalizeVisibleTranscript(output);
    if (!transcript.trim()) throw new Error('demo transcript is empty');
    return { status: 'ok', transcript, sha256: sha256Transcript(transcript) };
  } catch (error) {
    try { processHandle?.kill('SIGTERM'); } catch { /* best effort cleanup */ }
    return { status: 'failed', reasonCode: 'DEMO_TRANSCRIPT_FAILED', message: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export { DEMO_COLUMNS, DEMO_PROJECT_PATH, DEMO_ROWS, DEMO_VISIBLE_COMMANDS, collectDemoTranscript, normalizeVisibleTranscript, sha256Transcript };
export type { TranscriptCollector, TranscriptFailure, TranscriptResult, TranscriptSuccess };
