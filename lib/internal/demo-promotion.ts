import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEMO_ASSET_NAMES = ['gif', 'transcript', 'sha256'] as const;
type DemoAssetName = (typeof DEMO_ASSET_NAMES)[number];
type DemoAssetPaths = Record<DemoAssetName, string>;
type PromotionPhase = 'prepared' | 'promoting' | 'committed';
type PromotionEntry = {
  name: DemoAssetName;
  target: string;
  staging: string;
  backup: string;
  existed: boolean;
  oldSha256: string | null;
  newSha256: string;
};
type PromotionJournal = {
  version: 1;
  generation: string;
  phase: PromotionPhase;
  currentIndex: number;
  directory: string;
  entries: PromotionEntry[];
};
type PromotionResult = {
  status: 'committed' | 'failed';
  code: 'DEMO_PROMOTION_FAILED' | 'DEMO_PROMOTION_RECOVERY_REQUIRED' | 'DEMO_PROMOTION_CLEANUP_FAILED' | null;
  message: string | null;
};
type PromotionFs = Pick<typeof fs, 'copyFileSync' | 'existsSync' | 'lstatSync' | 'mkdirSync' | 'readFileSync' | 'renameSync' | 'rmSync' | 'statSync' | 'unlinkSync' | 'writeFileSync'> & {
  openSync?: typeof fs.openSync;
  closeSync?: typeof fs.closeSync;
  fsyncSync?: typeof fs.fsyncSync;
};

const JOURNAL_RELATIVE_PATH = 'assets/.demo-init.promotion.json';
const PROMOTION_DIR_PREFIX = '.demo-init.promotion-';

function sha256Bytes(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath: string, io: PromotionFs = fs): string {
  return sha256Bytes(io.readFileSync(filePath));
}

function assetTargets(cwd: string): DemoAssetPaths {
  return {
    gif: path.join(cwd, 'assets', 'demo-init.gif'),
    transcript: path.join(cwd, 'assets', 'demo-init.transcript'),
    sha256: path.join(cwd, 'assets', 'demo-init.transcript.sha256')
  };
}

function journalPath(cwd: string): string {
  return path.join(cwd, JOURNAL_RELATIVE_PATH);
}

function syncFile(filePath: string, io: PromotionFs): void {
  if (!io.openSync || !io.closeSync || !io.fsyncSync) return;
  const descriptor = io.openSync(filePath, 'r');
  try { io.fsyncSync(descriptor); } finally { io.closeSync(descriptor); }
}

function writeJournal(cwd: string, journal: PromotionJournal, io: PromotionFs): void {
  const target = journalPath(cwd);
  const temporary = `${target}.tmp-${process.pid}`;
  io.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`);
  syncFile(temporary, io);
  io.renameSync(temporary, target);
}

function existingRegularFile(filePath: string, io: PromotionFs): boolean {
  if (!io.existsSync(filePath)) return false;
  const stat = io.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`promotion target is not a regular file: ${filePath}`);
  return true;
}

function removeIfPresent(filePath: string, io: PromotionFs): void {
  if (io.existsSync(filePath)) io.unlinkSync(filePath);
}

function cleanupJournal(journal: PromotionJournal, cwd: string, io: PromotionFs): void {
  for (const entry of journal.entries) {
    removeIfPresent(entry.staging, io);
    removeIfPresent(entry.backup, io);
  }
  io.rmSync(path.join(cwd, journal.directory), { recursive: true, force: true });
  removeIfPresent(journalPath(cwd), io);
}

function verifyTargets(entries: readonly PromotionEntry[], io: PromotionFs, expected: 'old' | 'new'): void {
  for (const entry of entries) {
    if (!entry.existed && expected === 'old') {
      if (io.existsSync(entry.target)) throw new Error(`old promotion target unexpectedly exists: ${entry.target}`);
      continue;
    }
    if (!io.existsSync(entry.target)) throw new Error(`promotion target is missing: ${entry.target}`);
    const actual = sha256File(entry.target, io);
    const wanted = expected === 'old' ? entry.oldSha256 : entry.newSha256;
    if (!wanted || actual !== wanted) throw new Error(`promotion target has unexpected content: ${entry.target}`);
  }
}

function restoreOld(journal: PromotionJournal, io: PromotionFs): void {
  for (const entry of [...journal.entries].reverse()) {
    if (!entry.existed) {
      removeIfPresent(entry.target, io);
      continue;
    }
    if (!io.existsSync(entry.backup) || sha256File(entry.backup, io) !== entry.oldSha256) {
      throw new Error(`promotion backup is missing or corrupt: ${entry.backup}`);
    }
    const restore = `${entry.target}.restore-${process.pid}`;
    io.copyFileSync(entry.backup, restore);
    removeIfPresent(entry.target, io);
    io.renameSync(restore, entry.target);
  }
  verifyTargets(journal.entries, io, 'old');
}

function recoveryFailure(error: unknown): PromotionResult {
  return {
    status: 'failed',
    code: 'DEMO_PROMOTION_RECOVERY_REQUIRED',
    message: error instanceof Error ? error.message : String(error)
  };
}

function recoverDemoPromotion(cwd: string, io: PromotionFs = fs): PromotionResult | null {
  const target = journalPath(cwd);
  if (!io.existsSync(target)) return null;
  let journal: PromotionJournal;
  try {
    journal = JSON.parse(io.readFileSync(target, 'utf8')) as PromotionJournal;
    if (journal.version !== 1 || !Array.isArray(journal.entries) || !['prepared', 'promoting', 'committed'].includes(journal.phase)) {
      throw new Error('promotion journal is invalid');
    }
    if (journal.phase === 'committed') {
      try { verifyTargets(journal.entries, io, 'new'); }
      catch { restoreOld(journal, io); }
    } else {
      restoreOld(journal, io);
    }
    cleanupJournal(journal, cwd, io);
    return { status: 'committed', code: null, message: null };
  } catch (error) {
    return recoveryFailure(error);
  }
}

function createDemoPromotion(cwd: string, transcript: string): { directory: string; staging: DemoAssetPaths; sha256: string } {
  const assets = path.join(cwd, 'assets');
  const directory = fs.mkdtempSync(path.join(assets, PROMOTION_DIR_PREFIX));
  const staging: DemoAssetPaths = {
    gif: path.join(directory, 'demo-init.gif'),
    transcript: path.join(directory, 'demo-init.transcript'),
    sha256: path.join(directory, 'demo-init.transcript.sha256')
  };
  const sha256 = sha256Bytes(Buffer.from(transcript, 'utf8'));
  fs.writeFileSync(staging.transcript, transcript);
  fs.writeFileSync(staging.sha256, `${sha256}\n`);
  return { directory, staging, sha256 };
}

function promoteDemoAssets(cwd: string, staging: DemoAssetPaths, generation: string, io: PromotionFs = fs): PromotionResult {
  const targets = assetTargets(cwd);
  const directory = path.relative(cwd, path.dirname(staging.gif));
  const journal: PromotionJournal = {
    version: 1,
    generation,
    phase: 'prepared',
    currentIndex: -1,
    directory,
    entries: []
  };
  try {
    for (const name of DEMO_ASSET_NAMES) {
      if (!io.existsSync(staging[name])) throw new Error(`staged demo asset is missing: ${staging[name]}`);
      const target = targets[name];
      const backup = path.join(path.dirname(staging[name]), `old-${name}`);
      const existed = existingRegularFile(target, io);
      const oldSha256 = existed ? sha256File(target, io) : null;
      if (existed) {
        io.copyFileSync(target, backup);
        if (sha256File(backup, io) !== oldSha256) throw new Error(`promotion backup verification failed: ${target}`);
      }
      journal.entries.push({
        name, target, staging: staging[name], backup, existed, oldSha256,
        newSha256: sha256File(staging[name], io)
      });
    }
    writeJournal(cwd, journal, io);
    for (let index = 0; index < journal.entries.length; index += 1) {
      journal.phase = 'promoting';
      journal.currentIndex = index;
      writeJournal(cwd, journal, io);
      const entry = journal.entries[index]!;
      removeIfPresent(entry.target, io);
      io.renameSync(entry.staging, entry.target);
      if (sha256File(entry.target, io) !== entry.newSha256) throw new Error(`promoted asset verification failed: ${entry.target}`);
      writeJournal(cwd, journal, io);
    }
    verifyTargets(journal.entries, io, 'new');
    journal.phase = 'committed';
    writeJournal(cwd, journal, io);
    cleanupJournal(journal, cwd, io);
    return { status: 'committed', code: null, message: null };
  } catch (error) {
    try {
      if (io.existsSync(journalPath(cwd))) {
        const persisted = JSON.parse(io.readFileSync(journalPath(cwd), 'utf8')) as PromotionJournal;
        restoreOld(persisted, io);
        cleanupJournal(persisted, cwd, io);
      } else {
        io.rmSync(path.dirname(staging.gif), { recursive: true, force: true });
      }
      return { status: 'failed', code: 'DEMO_PROMOTION_FAILED', message: error instanceof Error ? error.message : String(error) };
    } catch (rollbackError) {
      return recoveryFailure(rollbackError);
    }
  }
}

export {
  DEMO_ASSET_NAMES,
  JOURNAL_RELATIVE_PATH,
  assetTargets,
  createDemoPromotion,
  journalPath,
  promoteDemoAssets,
  recoverDemoPromotion,
  sha256Bytes
};
export type { DemoAssetName, DemoAssetPaths, PromotionFs, PromotionResult };
