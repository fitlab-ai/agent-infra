import fs from 'node:fs';
import path from 'node:path';
import {
  clipboardHostDir,
  containerClipboardPath,
  pngClipboardFilename,
  pruneClipboardDir,
  writeClipboardPngAtomic
} from './paths.ts';

export const RECEIVER_CAPABILITY = 'AGENT_INFRA_CLIPBOARD_RECEIVER:v1';
const MARKER = '.pending.json';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HASHED_PNG = /^[a-f0-9]{16}\.png$/u;
const REMOTE_TEMP = /^agent-infra-cp-[0-9a-f-]{36}\.png$/u;

export function isClipboardInboxReadable(home: string): boolean {
  const dir = clipboardHostDir(home);
  try {
    fs.accessSync(dir, fs.constants.R_OK);
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function receiveRemoteClipboardPng(home: string, tempPath: string, platformName: NodeJS.Platform = process.platform): string {
  if (platformName !== 'linux') throw new Error('remote clipboard receiver requires Linux');
  if (path.dirname(tempPath) !== '/tmp' || !REMOTE_TEMP.test(path.basename(tempPath))) {
    throw new Error('invalid clipboard upload path');
  }
  const signature = Buffer.alloc(PNG_SIGNATURE.length);
  const fd = fs.openSync(tempPath, 'r');
  let signatureBytes: number;
  try {
    signatureBytes = fs.readSync(fd, signature, 0, signature.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (signatureBytes !== PNG_SIGNATURE.length || !signature.equals(PNG_SIGNATURE)) {
    throw new Error('uploaded clipboard file is not a PNG');
  }
  const png = fs.readFileSync(tempPath);
  const dir = clipboardHostDir(home);
  if (!fs.existsSync(path.dirname(dir))) throw new Error('agent-infra is not installed on this host');
  const filename = pngClipboardFilename(png);
  writeClipboardPngAtomic(dir, filename, png);
  pruneClipboardDir(dir);
  const markerTmp = path.join(dir, `.${MARKER}.${process.pid}.tmp`);
  fs.writeFileSync(markerTmp, JSON.stringify({ version: 1, filename, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
  fs.renameSync(markerTmp, path.join(dir, MARKER));
  return containerClipboardPath(filename);
}

export function readPendingClipboardPath(home: string): string | null {
  const dir = clipboardHostDir(home);
  const markerPath = path.join(dir, MARKER);
  let markerText: string;
  try {
    markerText = fs.readFileSync(markerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('invalid clipboard pending marker', { cause: error });
  }

  let marker: { version?: unknown; filename?: unknown };
  try {
    marker = JSON.parse(markerText) as { version?: unknown; filename?: unknown };
  } catch (error) {
    throw new Error('invalid clipboard pending marker', { cause: error });
  }
  if (marker.version !== 1 || typeof marker.filename !== 'string' || !HASHED_PNG.test(marker.filename)) {
    throw new Error('invalid clipboard pending marker');
  }
  const filePath = path.join(dir, marker.filename);
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('pending clipboard image is not a regular file');
  } catch (error) {
    throw new Error('invalid clipboard pending marker', { cause: error });
  }
  return containerClipboardPath(marker.filename);
}
