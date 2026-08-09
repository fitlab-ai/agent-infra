import fs from 'node:fs';
import path from 'node:path';

import { canonicalJsonBytes, sha256, verifySnapshot } from './store.ts';

import type { RepairAction } from './types.ts';
import type { NormalizedRecord } from './types.ts';

type RepairResult = { applied: boolean; repairId: string | null; actionCount: number; path?: string };

function readRepairActions(snapshotPath: string): RepairAction[] {
  const filePath = path.join(snapshotPath, 'repair-manifest.jsonl');
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
    const { schema: _schema, ...action } = JSON.parse(line) as { schema: string } & RepairAction;
    return action;
  });
}

function repairSnapshot(root: string, snapshotId: string, apply: boolean): RepairResult {
  const verified = verifySnapshot(root, snapshotId);
  if (!verified.ok || !verified.snapshotPath) throw new Error(`snapshot verification failed: ${verified.errors.join('; ')}`);
  const actions = readRepairActions(verified.snapshotPath);
  const records = new Map(
    fs.readFileSync(path.join(verified.snapshotPath, 'normalized.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => {
      const record = JSON.parse(line) as { schema: string } & NormalizedRecord;
      return [record.recordId, record] as const;
    })
  );
  for (const action of actions) {
    const source = records.get(action.sourceRecordId);
    const target = records.get(action.targetRecordId);
    if (!source || !target) throw new Error(`repair references a missing record: ${action.repairId}`);
    if (sha256(`${source.sourceSha256}:${target.sourceSha256}`) !== action.preconditionSha256) {
      throw new Error(`repair precondition failed: ${action.repairId}`);
    }
  }
  if (!apply || actions.length === 0) return { applied: false, repairId: null, actionCount: actions.length };

  const digest = sha256(canonicalJsonBytes(actions));
  const repairId = `repair-${digest.slice(0, 16)}`;
  const repairDir = path.join(root, 'repairs', snapshotId, repairId);
  const manifest = `${canonicalJsonBytes({ schema: 'repair-application/v1', snapshotId, repairId, actionCount: actions.length, overlaySha256: digest }).toString('utf8')}\n`;
  const overlay = actions.map((action) => `${canonicalJsonBytes({ schema: 'normalized-overlay/v1', ...action }).toString('utf8')}\n`).join('');
  if (fs.existsSync(repairDir)) {
    if (fs.readFileSync(path.join(repairDir, 'manifest.json'), 'utf8') !== manifest) throw new Error(`repair collision: ${repairId}`);
    return { applied: false, repairId, actionCount: actions.length, path: repairDir };
  }
  fs.mkdirSync(repairDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(repairDir, 'manifest.json'), manifest, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(repairDir, 'overlay.jsonl'), overlay, { mode: 0o600, flag: 'wx' });
  return { applied: true, repairId, actionCount: actions.length, path: repairDir };
}

function readAppliedOverlays(root: string, snapshotId: string): string {
  const base = path.join(root, 'repairs', snapshotId);
  if (!fs.existsSync(base)) return '';
  return fs.readdirSync(base).sort().map((entry) => {
    const overlay = path.join(base, entry, 'overlay.jsonl');
    return fs.existsSync(overlay) ? fs.readFileSync(overlay, 'utf8') : '';
  }).join('');
}

export { readAppliedOverlays, repairSnapshot };
