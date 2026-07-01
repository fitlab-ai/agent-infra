import { redactSecrets } from './redact.ts';
import type { RunnerResult } from './runner.ts';

export type StreamOptions = {
  title: string;
  chunkChars?: number;
  throttleMs?: number;
};

function chunks(text: string, size: number): string[] {
  if (text.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

export async function streamCommand(
  options: StreamOptions,
  run: (emit?: (chunk: string) => Promise<void>) => Promise<RunnerResult>,
  send: (text: string) => Promise<void>
): Promise<RunnerResult> {
  await send(`started ${options.title}`);
  const size = options.chunkChars ?? 4000;
  const throttleMs = options.throttleMs ?? 0;
  let streamed = false;
  let buffer = '';
  let lastFlush = 0;

  const flush = async (): Promise<void> => {
    if (!buffer) return;
    const text = redactSecrets(buffer);
    buffer = '';
    lastFlush = Date.now();
    for (const chunk of chunks(text, size)) {
      await send(chunk);
    }
  };

  const emit = async (chunk: string): Promise<void> => {
    streamed = true;
    buffer += chunk;
    const due = throttleMs === 0 || Date.now() - lastFlush >= throttleMs;
    if (buffer.length >= size || due) {
      await flush();
    }
  };

  const result = await run(emit);
  if (!streamed) {
    buffer += [result.stdout, result.stderr].filter(Boolean).join('\n');
  }
  await flush();
  await send(`finished ${options.title} exitCode=${result.exitCode} signal=${result.signal ?? 'null'}`);
  return result;
}
