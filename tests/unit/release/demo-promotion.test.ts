import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEMO_ASSET_NAMES,
  journalPath,
  promoteDemoAssets,
  recoverDemoPromotion
} from '../../../lib/internal/demo-promotion.ts';
import { sha256Bytes } from '../../../lib/internal/demo-promotion.ts';
import type { DemoAssetPaths, PromotionFs } from '../../../lib/internal/demo-promotion.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-demo-promotion-'));
  const assets = path.join(root, 'assets');
  fs.mkdirSync(assets);
  const stagingDir = fs.mkdtempSync(path.join(assets, '.demo-init.promotion-'));
  const staging: DemoAssetPaths = {
    gif: path.join(stagingDir, 'demo-init.gif'),
    transcript: path.join(stagingDir, 'demo-init.transcript'),
    sha256: path.join(stagingDir, 'demo-init.transcript.sha256')
  };
  fs.writeFileSync(staging.gif, 'GIF89a-new');
  fs.writeFileSync(staging.transcript, 'new transcript\n');
  fs.writeFileSync(staging.sha256, 'new transcript digest\n');
  for (const name of DEMO_ASSET_NAMES) fs.writeFileSync(path.join(assets, `demo-init.${name === 'sha256' ? 'transcript.sha256' : name}`), `old ${name}\n`);
  return { root, assets, staging };
}

function targetFor(assets: string, name: keyof DemoAssetPaths): string {
  return path.join(assets, name === 'gif' ? 'demo-init.gif' : `demo-init.transcript${name === 'sha256' ? '.sha256' : ''}`);
}

function assertTargets(root: string, expected: 'old' | 'new', absent: keyof DemoAssetPaths | null = null) {
  const assets = path.join(root, 'assets');
  for (const name of DEMO_ASSET_NAMES) {
    const target = targetFor(assets, name);
    if (expected === 'old' && absent === name) {
      assert.equal(fs.existsSync(target), false, target);
      continue;
    }
    assert.equal(fs.readFileSync(target, 'utf8'), expected === 'old'
      ? `old ${name}\n`
      : name === 'gif' ? 'GIF89a-new' : name === 'sha256' ? 'new transcript digest\n' : 'new transcript\n');
  }
}

function assertNoPromotionArtifacts(assets: string) {
  assert.equal(fs.existsSync(journalPath(path.dirname(assets))), false);
  assert.equal(fs.readdirSync(assets).some((name) => name.includes('.demo-init.promotion.json.tmp-')), false);
  assert.equal(fs.readdirSync(assets).some((name) => name.startsWith('.demo-init.promotion-')), false);
}

function isPromotionBackupPath(filePath: fs.PathLike): boolean {
  const value = String(filePath);
  return [path.posix.basename(value), path.win32.basename(value)].some((name) => name.startsWith('old-'));
}

function writeInterruptedJournal(
  root: string,
  staging: DemoAssetPaths,
  phaseIndex: number,
  afterReplacement: boolean
): void {
  const assets = path.join(root, 'assets');
  const directory = path.relative(root, path.dirname(staging.gif));
  const entries = DEMO_ASSET_NAMES.map((name) => {
    const target = targetFor(assets, name);
    const backup = path.join(path.dirname(staging[name]), `old-${name}`);
    fs.copyFileSync(target, backup);
    return {
      name,
      target,
      staging: staging[name],
      backup,
      existed: true,
      oldSha256: sha256Bytes(fs.readFileSync(target)),
      newSha256: sha256Bytes(fs.readFileSync(staging[name]))
    };
  });
  if (afterReplacement) {
    for (let index = 0; index <= phaseIndex; index += 1) {
      const name = DEMO_ASSET_NAMES[index]!;
      fs.copyFileSync(staging[name], targetFor(assets, name));
      fs.unlinkSync(staging[name]);
    }
  }
  fs.writeFileSync(journalPath(root), JSON.stringify({
    version: 1,
    generation: `interrupted-${phaseIndex}-${afterReplacement ? 'after' : 'before'}`,
    phase: 'promoting',
    currentIndex: phaseIndex,
    directory,
    entries
  }, null, 2));
}

function withJournalFault(root: string, writeNumber: number, alsoBreakRestore = false): PromotionFs {
  let journalWrites = 0;
  let restoreBroken = false;
  return {
    ...fs,
    renameSync(source: fs.PathLike, destination: fs.PathLike) {
      if (String(destination) === journalPath(root) && String(source).includes('.promotion.json.tmp-')) {
        journalWrites += 1;
        if (journalWrites === writeNumber) throw new Error(`injected journal failure ${writeNumber}`);
      }
      if (alsoBreakRestore && !restoreBroken && String(destination).endsWith('demo-init.gif') && String(source).includes('.restore-')) {
        restoreBroken = true;
        throw new Error('injected rollback failure');
      }
      return fs.renameSync(source, destination);
    }
  } as unknown as PromotionFs;
}

for (const [index, name] of DEMO_ASSET_NAMES.entries()) {
  test(`promotion rolls back when journal write fails before replacing ${name}`, () => {
    const { root, assets, staging } = fixture();
    try {
      const result = promoteDemoAssets(root, staging, `before-${name}`, withJournalFault(root, 2 + index * 2));
      assert.equal(result.status, 'failed');
      assert.equal(result.code, 'DEMO_PROMOTION_FAILED');
      assertTargets(root, 'old');
      assertNoPromotionArtifacts(assets);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`promotion rolls back when journal write fails after replacing ${name}`, () => {
    const { root, assets, staging } = fixture();
    try {
      const result = promoteDemoAssets(root, staging, `after-${name}`, withJournalFault(root, 3 + index * 2));
      assert.equal(result.status, 'failed');
      assert.equal(result.code, 'DEMO_PROMOTION_FAILED');
      assertTargets(root, 'old');
      assertNoPromotionArtifacts(assets);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('promotion rolls back when a promoted target fails validation', () => {
  const { root, assets, staging } = fixture();
  let replaced = false;
  let injected = false;
  const io = {
    ...fs,
    renameSync(source: fs.PathLike, destination: fs.PathLike) {
      if (String(destination) === targetFor(assets, 'transcript') && String(source).includes('.demo-init.promotion-')) replaced = true;
      return fs.renameSync(source, destination);
    },
    readFileSync(filePath: fs.PathLike, options?: any) {
      if (replaced && !injected && String(filePath) === targetFor(assets, 'transcript')) {
        injected = true;
        return Buffer.from('corrupt target');
      }
      return fs.readFileSync(filePath, options);
    }
  } as unknown as PromotionFs;
  try {
    const result = promoteDemoAssets(root, staging, 'validation-failure', io);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'DEMO_PROMOTION_FAILED');
    assertTargets(root, 'old');
    assertNoPromotionArtifacts(assets);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('promotion rolls back when the committed journal cannot be written', () => {
  const { root, assets, staging } = fixture();
  try {
    const result = promoteDemoAssets(root, staging, 'committed-journal-failure', withJournalFault(root, 8));
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'DEMO_PROMOTION_FAILED');
    assertTargets(root, 'old');
    assertNoPromotionArtifacts(assets);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup failure preserves a committed generation for recovery', () => {
  const { root, assets, staging } = fixture();
  let injected = false;
  const io = {
    ...fs,
    unlinkSync(filePath: fs.PathLike) {
      if (!injected && isPromotionBackupPath(filePath)) {
        injected = true;
        throw new Error('injected cleanup failure');
      }
      return fs.unlinkSync(filePath);
    }
  } as unknown as PromotionFs;
  try {
    const result = promoteDemoAssets(root, staging, 'cleanup-failure', io);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'DEMO_PROMOTION_CLEANUP_FAILED');
    assertTargets(root, 'new');
    assert.equal(fs.existsSync(journalPath(root)), true);

    const recovered = recoverDemoPromotion(root);
    assert.deepEqual(recovered, { status: 'committed', code: null, message: null });
    assertTargets(root, 'new');
    assertNoPromotionArtifacts(assets);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup fault predicate recognizes POSIX and Windows backup paths', () => {
  assert.equal(isPromotionBackupPath(path.posix.join('/tmp', 'old-gif')), true);
  assert.equal(isPromotionBackupPath(path.win32.join('C:\\tmp', 'old-gif')), true);
  assert.equal(isPromotionBackupPath(path.posix.join('/tmp', 'demo-init.gif')), false);
});

test('promotion records and replaces a previously absent target', () => {
  const { root, assets, staging } = fixture();
  const absent: keyof DemoAssetPaths = 'transcript';
  fs.unlinkSync(targetFor(assets, absent));
  try {
    const result = promoteDemoAssets(root, staging, 'absent-target', fs as unknown as PromotionFs);
    assert.deepEqual(result, { status: 'committed', code: null, message: null });
    assertTargets(root, 'new');
    assertNoPromotionArtifacts(assets);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted rollback remains recoverable from the promotion journal', () => {
  const { root, assets, staging } = fixture();
  const target = targetFor(assets, 'gif');
  try {
    const result = promoteDemoAssets(root, staging, 'generation-2', withJournalFault(root, 3, true));
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'DEMO_PROMOTION_RECOVERY_REQUIRED');
    assert.equal(fs.existsSync(path.join(assets, '.demo-init.promotion.json')), true);

    const recovered = recoverDemoPromotion(root);
    assert.deepEqual(recovered, { status: 'committed', code: null, message: null });
    assert.equal(fs.readFileSync(target, 'utf8'), 'old gif\n');
    assert.equal(fs.existsSync(path.join(assets, '.demo-init.promotion.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const [index, name] of DEMO_ASSET_NAMES.entries()) {
  for (const afterReplacement of [false, true]) {
    test(`fresh recovery restores all assets after interruption ${afterReplacement ? 'after' : 'before'} replacing ${name}`, () => {
      const { root, assets, staging } = fixture();
      try {
        writeInterruptedJournal(root, staging, index, afterReplacement);
        const recovered = recoverDemoPromotion(root);
        assert.deepEqual(recovered, { status: 'committed', code: null, message: null });
        assertTargets(root, 'old');
        assertNoPromotionArtifacts(assets);
        assert.equal(recoverDemoPromotion(root), null);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test('recovery rejects a journal path outside assets without deleting it', () => {
  const { root, assets, staging } = fixture();
  const sentinel = path.join(path.dirname(root), 'demo-promotion-sentinel');
  fs.writeFileSync(sentinel, 'keep me\n');
  try {
    writeInterruptedJournal(root, staging, 0, true);
    const journal = JSON.parse(fs.readFileSync(journalPath(root), 'utf8')) as { entries: Array<{ target: string }> };
    journal.entries[0]!.target = sentinel;
    fs.writeFileSync(journalPath(root), JSON.stringify(journal));

    const recovered = recoverDemoPromotion(root);
    assert.equal(recovered?.status, 'failed');
    assert.equal(recovered?.code, 'DEMO_PROMOTION_RECOVERY_REQUIRED');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep me\n');
    assert.equal(fs.existsSync(journalPath(root)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sentinel, { force: true });
  }
});
