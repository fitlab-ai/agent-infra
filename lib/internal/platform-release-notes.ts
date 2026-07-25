import fs from 'node:fs';
import path from 'node:path';

import { publishReleaseNotes, releaseNoteContext } from '../platform/release-notes.ts';

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1]! : null;
}

function finish(result: { status: string; [key: string]: unknown }): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'blocked' ? 2 : result.status === 'failed' ? 1 : 0;
}

function platformReleaseNotes(args: string[] = []): void {
  const [action, ...rest] = args;
  const cwd = path.resolve(option(rest, '--cwd') || process.cwd());
  if (action === 'context') {
    const historyRaw = option(rest, '--history-limit');
    finish(releaseNoteContext({
      fromTag: option(rest, '--from-tag') || '',
      toTag: option(rest, '--to-tag') || '',
      branch: option(rest, '--branch') || '',
      historyLimit: historyRaw === null ? undefined : Number(historyRaw)
    }, { cwd }));
    return;
  }
  if (action === 'publish') {
    const notesPath = option(rest, '--notes-file');
    if (!notesPath) {
      finish({ status: 'failed', changed: false, error: { code: 'RELEASE_NOTES_INPUT_INVALID', message: 'notes-file is required', retryable: false } });
      return;
    }
    let resolvedNotesPath = notesPath;
    if (notesPath === '-') {
      resolvedNotesPath = path.join(process.env.TMPDIR || '/tmp', `agent-infra-release-notes-${process.pid}.md`);
      fs.writeFileSync(resolvedNotesPath, fs.readFileSync(0));
    }
    try {
      finish(publishReleaseNotes({
        tag: option(rest, '--tag') || '',
        title: option(rest, '--title') || option(rest, '--tag') || '',
        notesFile: resolvedNotesPath,
        dryRun: rest.includes('--dry-run')
      }, { cwd }));
    } finally {
      if (notesPath === '-') fs.rmSync(resolvedNotesPath, { force: true });
    }
    return;
  }
  finish({ status: 'failed', changed: false, error: { code: 'RELEASE_NOTES_INPUT_INVALID', message: 'Usage: platform-release-notes context|publish', retryable: false } });
}

export { platformReleaseNotes };
