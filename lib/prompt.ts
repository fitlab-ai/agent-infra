import readline from 'node:readline';
import { ask } from './log.ts';

let _rl: readline.Interface | null = null;
let _lines: string[] = [];
let _lineResolve: ((value: string | null) => void) | null = null;
let _stdinDone = false;

function setupInterface() {
  if (_rl || _stdinDone) return;
  _rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  });

  _rl.on('line', (line) => {
    if (_lineResolve) {
      const resolve = _lineResolve;
      _lineResolve = null;
      resolve(line);
    } else {
      _lines.push(line);
    }
  });

  _rl.on('close', () => {
    _stdinDone = true;
    _rl = null;
    if (_lineResolve) {
      const resolve = _lineResolve;
      _lineResolve = null;
      resolve(null);
    }
  });
}

function nextLine(): Promise<string | null> {
  return new Promise((resolve) => {
    if (_lines.length > 0) {
      resolve(_lines.shift() ?? null);
    } else if (_stdinDone) {
      resolve(null);
    } else {
      _lineResolve = resolve;
    }
  });
}

async function prompt(question: string, defaultValue: string): Promise<string> {
  const label = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  ask(label);

  setupInterface();

  const line = await nextLine();
  if (line === null) {
    return defaultValue || '';
  }
  return line.trim() || defaultValue || '';
}

async function select(question: string, choices: string[], defaultValue?: string): Promise<string> {
  const defaultIndex = defaultValue === undefined ? -1 : choices.indexOf(defaultValue);

  process.stdout.write(`  ${question}:\n`);
  choices.forEach((choice, index) => {
    const suffix = index === defaultIndex ? ' (default)' : '';
    process.stdout.write(`      ${index + 1}) ${choice}${suffix}\n`);
  });

  ask(defaultIndex >= 0 ? `Select [${defaultIndex + 1}]: ` : 'Select: ');

  setupInterface();

  const line = await nextLine();
  if (line === null || line.trim() === '') {
    return defaultValue || choices[0] || '';
  }

  const trimmed = line.trim();
  const selectedIndex = Number.parseInt(trimmed, 10);
  if (String(selectedIndex) === trimmed && selectedIndex >= 1 && selectedIndex <= choices.length) {
    return choices[selectedIndex - 1] ?? '';
  }

  return trimmed;
}

function closePrompt(): void {
  if (_rl) {
    _rl.close();
    _rl = null;
    _stdinDone = true;
  }
}

export { prompt, select, closePrompt };
