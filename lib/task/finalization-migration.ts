import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';

import { resolveTaskFinalizationDirectory, validateTaskFinalizationReceipt } from './finalization.ts';

export type FinalizationReceiptMigrationItem = Readonly<{
  source: string;
  taskId: string | null;
  status: 'would-migrate' | 'migrated' | 'already-migrated' | 'skipped';
  reason: string | null;
}>;

export type FinalizationReceiptMigrationResult = Readonly<{
  dryRun: boolean;
  items: readonly FinalizationReceiptMigrationItem[];
  failed: boolean;
}>;

const TASK_ID_PATTERN = /^TASK-\d{8}-\d{6}$/u;

function failure(source: string, taskId: string | null, reason: string): FinalizationReceiptMigrationItem {
  return { source, taskId, status: 'skipped', reason };
}

function readReceipt(file: string, taskId: string): unknown {
  return validateTaskFinalizationReceipt(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, taskId);
}

export function migrateFinalizationReceipts(
  repoRoot: string,
  options: Readonly<{ dryRun?: boolean }> = {}
): FinalizationReceiptMigrationResult {
  const dryRun = options.dryRun === true;
  const root = path.resolve(repoRoot);
  const sourceDir = path.join(root, '.agents', 'workspace', '.task-finalization');
  if (!fs.existsSync(sourceDir)) return { dryRun, items: [], failed: false };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch (error) {
    return {
      dryRun,
      items: [failure(sourceDir, null, `SOURCE_DIRECTORY_UNREADABLE: ${error instanceof Error ? error.message : String(error)}`)],
      failed: true
    };
  }

  const items: FinalizationReceiptMigrationItem[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const source = path.join(sourceDir, entry.name);
    const match = /^(.*)\.json$/u.exec(entry.name);
    const taskId = match?.[1] ?? null;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      items.push(failure(source, taskId, 'SOURCE_ENTRY_NOT_REGULAR_FILE'));
      continue;
    }
    if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
      items.push(failure(source, taskId, 'SOURCE_TASK_ID_INVALID'));
      continue;
    }

    let receipt: unknown;
    try {
      receipt = readReceipt(source, taskId);
    } catch (error) {
      items.push(failure(source, taskId, `RECEIPT_INVALID: ${error instanceof Error ? error.message : String(error)}`));
      continue;
    }

    let taskDir: string | null;
    try {
      taskDir = resolveTaskFinalizationDirectory(root, taskId);
    } catch (error) {
      items.push(failure(source, taskId, `TASK_IDENTITY_UNRESOLVED: ${error instanceof Error ? error.message : String(error)}`));
      continue;
    }
    if (!taskDir) {
      items.push(failure(source, taskId, 'TASK_NOT_FOUND'));
      continue;
    }

    const target = path.join(taskDir, '.task-finalization.json');
    let targetReceipt: unknown = null;
    if (fs.existsSync(target)) {
      try {
        const targetStat = fs.lstatSync(target);
        if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error('target is not a regular file');
        targetReceipt = readReceipt(target, taskId);
      } catch (error) {
        items.push(failure(source, taskId, `TARGET_CONFLICT: ${error instanceof Error ? error.message : String(error)}`));
        continue;
      }
      if (!isDeepStrictEqual(receipt, targetReceipt)) {
        items.push(failure(source, taskId, 'TARGET_CONFLICT: destination receipt differs from source'));
        continue;
      }
      if (dryRun) {
        items.push({ source, taskId, status: 'already-migrated', reason: 'matching destination exists; source can be removed' });
        continue;
      }
      try {
        fs.unlinkSync(source);
        items.push({ source, taskId, status: 'already-migrated', reason: null });
      } catch (error) {
        items.push(failure(source, taskId, `SOURCE_CLEANUP_FAILED: ${error instanceof Error ? error.message : String(error)}`));
      }
      continue;
    }

    if (dryRun) {
      items.push({ source, taskId, status: 'would-migrate', reason: null });
      continue;
    }

    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: 'wx' });
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary);
      const migrated = readReceipt(target, taskId);
      if (!isDeepStrictEqual(receipt, migrated)) throw new Error('destination readback differs from source');
      fs.unlinkSync(source);
      items.push({ source, taskId, status: 'migrated', reason: null });
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* preserve the migration error */ }
      items.push(failure(source, taskId, `MIGRATION_FAILED: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  if (!dryRun && items.every((item) => item.status !== 'skipped')) {
    try {
      if (fs.readdirSync(sourceDir).length === 0) fs.rmdirSync(sourceDir);
    } catch { /* an empty legacy directory can be removed later without changing receipt state */ }
  }
  return { dryRun, items, failed: items.some((item) => item.status === 'skipped') };
}
