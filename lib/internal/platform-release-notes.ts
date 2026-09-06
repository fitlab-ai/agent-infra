import fs from 'node:fs';
import path from 'node:path';

import { publishReleaseNotes, releaseNoteContext, stageReleaseNotes } from '../platform/release-notes.ts';
import { ensureInternalHandlerRoute, internalHandlerRoute } from './cli-route-inventory.ts';

type ParsedOptions = Readonly<{ values: ReadonlyMap<string, string>; switches: ReadonlySet<string> }>;

function parseOptions(
  args: string[],
  valueFlags: readonly string[],
  switchFlags: readonly string[] = []
): ParsedOptions | null {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (values.has(flag) || switches.has(flag)) return null;
    if (switchFlags.includes(flag)) {
      switches.add(flag);
      continue;
    }
    if (!valueFlags.includes(flag)) return null;
    const value = args[++index];
    if (!value || value.startsWith('--')) return null;
    values.set(flag, value);
  }
  return { values, switches };
}

function invalidInput(message: string) {
  return { status: 'failed', changed: false, error: { code: 'RELEASE_NOTES_INPUT_INVALID', message, retryable: false } };
}

function finish(result: { status: string; [key: string]: unknown }): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'blocked' ? 2 : result.status === 'failed' ? 1 : 0;
}

async function platformReleaseNotes(args: string[] = []): Promise<void> {
  if (!ensureInternalHandlerRoute('platform-release-notes', args)) return;
  const [action, ...rest] = args;
  if (internalHandlerRoute('platform-release-notes', 'context', action ?? '')) {
    const parsed = parseOptions(rest, ['--cwd', '--history-limit', '--from-tag', '--to-tag', '--branch']);
    if (!parsed) return finish(invalidInput('invalid context options'));
    const cwd = path.resolve(parsed.values.get('--cwd') || process.cwd());
    const historyRaw = parsed.values.get('--history-limit') ?? null;
    finish(await releaseNoteContext({
      fromTag: parsed.values.get('--from-tag') || '',
      toTag: parsed.values.get('--to-tag') || '',
      branch: parsed.values.get('--branch') || '',
      historyLimit: historyRaw === null ? undefined : Number(historyRaw)
    }, { cwd }));
    return;
  }
  if (internalHandlerRoute('platform-release-notes', 'stage', action ?? '')) {
    const parsed = parseOptions(rest, ['--cwd', '--notes-file']);
    if (!parsed) return finish(invalidInput('invalid stage options'));
    const notesFile = parsed.values.get('--notes-file');
    if (!notesFile) return finish(invalidInput('notes-file is required'));
    finish(stageReleaseNotes(
      { notesFile },
      { cwd: path.resolve(parsed.values.get('--cwd') || process.cwd()) }
    ));
    return;
  }
  if (internalHandlerRoute('platform-release-notes', 'publish', action ?? '')) {
    const parsed = parseOptions(
      rest,
      ['--cwd', '--notes-file', '--tag', '--title', '--expected-sha256'],
      ['--dry-run']
    );
    if (!parsed) return finish(invalidInput('invalid publish options'));
    const notesPath = parsed.values.get('--notes-file');
    if (!notesPath) {
      finish(invalidInput('notes-file is required'));
      return;
    }
    let resolvedNotesPath = notesPath;
    if (notesPath === '-') {
      resolvedNotesPath = path.join(process.env.TMPDIR || '/tmp', `agent-infra-release-notes-${process.pid}.md`);
      fs.writeFileSync(resolvedNotesPath, fs.readFileSync(0));
    }
    try {
      finish(await publishReleaseNotes({
        tag: parsed.values.get('--tag') || '',
        title: parsed.values.get('--title') || parsed.values.get('--tag') || '',
        notesFile: resolvedNotesPath,
        expectedSha256: parsed.values.get('--expected-sha256') || '',
        dryRun: parsed.switches.has('--dry-run')
      }, { cwd: path.resolve(parsed.values.get('--cwd') || process.cwd()) }));
    } finally {
      if (notesPath === '-') fs.rmSync(resolvedNotesPath, { force: true });
    }
    return;
  }
  finish(invalidInput('Usage: platform-release-notes context|stage|publish'));
}

export { platformReleaseNotes };
