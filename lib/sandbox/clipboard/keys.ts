export type CtrlVMatch = {
  kind: 'ctrl-v';
  raw: string;
  label: string;
};

export type KeyToken =
  | { kind: 'text'; raw: string }
  | CtrlVMatch;

const CTRL_V_SEQUENCES = [
  { raw: '\x16', label: 'ctrl-v 0x16' },
  { raw: '\x1b[118;5u', label: 'ctrl-v csi-u ESC[118;5u' },
  { raw: '\x1b[27;5;118~', label: 'ctrl-v modifyOtherKeys ESC[27;5;118~' }
];

export class CtrlVDetector {
  #pending = '';

  hasPending(): boolean {
    return this.#pending.length > 0;
  }

  feed(raw: string): KeyToken[] {
    let input = this.#pending + raw;
    this.#pending = '';
    const tokens: KeyToken[] = [];

    while (input.length > 0) {
      const match = CTRL_V_SEQUENCES.find((sequence) => input.startsWith(sequence.raw));
      if (match) {
        tokens.push({ kind: 'ctrl-v', raw: match.raw, label: match.label });
        input = input.slice(match.raw.length);
        continue;
      }

      const partial = CTRL_V_SEQUENCES.some((sequence) =>
        sequence.raw.startsWith(input) && input.length < sequence.raw.length
      );
      if (partial) {
        this.#pending = input;
        break;
      }

      const first = input.slice(0, 1);
      tokens.push({ kind: 'text', raw: first });
      input = input.slice(first.length);
    }

    return coalesceText(tokens);
  }

  flush(): KeyToken[] {
    if (!this.#pending) {
      return [];
    }
    const raw = this.#pending;
    this.#pending = '';
    return [{ kind: 'text', raw }];
  }
}

function coalesceText(tokens: KeyToken[]): KeyToken[] {
  const result: KeyToken[] = [];
  for (const token of tokens) {
    const previous = result.at(-1);
    if (token.kind === 'text' && previous?.kind === 'text') {
      previous.raw += token.raw;
    } else {
      result.push(token);
    }
  }
  return result;
}

export function buildBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}
