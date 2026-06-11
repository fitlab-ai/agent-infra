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

async function multiSelect(
  question: string,
  choices: { id: string; label: string }[]
): Promise<string[]> {
  process.stdout.write(`  ${question}:\n`);
  const idWidth = Math.max(...choices.map((c) => c.id.length));
  choices.forEach((c, i) => {
    process.stdout.write(`      ${i + 1}) ${c.id.padEnd(idWidth)}  (${c.label})\n`);
  });
  ask('Enter comma-separated numbers or ids to keep, or "none" to select nothing [default: all]: ');

  setupInterface();

  const line = await nextLine();
  // Strictly distinguish bare Enter (null/empty string) from whitespace input.
  if (line === null || line === '') return choices.map((c) => c.id);
  // Explicit empty selection: "none" means deliberately zero built-in choices.
  if (line.trim().toLowerCase() === 'none') return [];

  const tokens = line.split(',').map((t) => t.trim());
  if (tokens.some((t) => t === '')) {
    throw new Error(`Invalid selection input: "${line}" (empty token)`);
  }

  const idSet = new Set(choices.map((c) => c.id));
  const seenIds = new Set<string>();
  for (const t of tokens) {
    let resolvedId: string | undefined;
    if (/^[0-9]+$/.test(t)) {
      const n = Number.parseInt(t, 10);
      if (n < 1 || n > choices.length) {
        throw new Error(`Selection out of range: "${t}" (expected 1..${choices.length})`);
      }
      resolvedId = choices[n - 1]!.id;
    } else if (idSet.has(t)) {
      resolvedId = t;
    } else {
      throw new Error(`Unknown TUI selection token: "${t}"`);
    }
    if (seenIds.has(resolvedId)) {
      throw new Error(`Duplicate selection: "${t}" resolves to already-selected "${resolvedId}"`);
    }
    seenIds.add(resolvedId);
  }

  // Normalize to prompt order: users can type tokens in any order, but the
  // persisted array follows the canonical choices order to keep .airc.json
  // diffs stable. An empty result here is impossible (tokens.length > 0 and
  // every token resolves to an id), so no separate empty guard is needed —
  // explicit "none" handled above.
  return choices.map((c) => c.id).filter((id) => seenIds.has(id));
}

function closePrompt(): void {
  if (_rl) {
    _rl.close();
    _rl = null;
    _stdinDone = true;
  }
}

export { prompt, select, multiSelect, closePrompt };
