import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEMO_ASSET_NAMES,
  promoteDemoAssets,
  recoverDemoPromotion
} from '../../../lib/internal/demo-promotion.ts';
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

function withRenameFault(target: string, alsoBreakRestore = false): PromotionFs {
  let injected = false;
  let restoreBroken = false;
  return {
    ...fs,
    renameSync(source: fs.PathLike, destination: fs.PathLike) {
      if (!injected && String(destination) === target && String(source).includes('.demo-init.promotion-')) {
        injected = true;
        throw new Error(`injected replacement failure for ${target}`);
      }
      if (alsoBreakRestore && !restoreBroken && String(destination) === target && String(source).includes('.restore-')) {
        restoreBroken = true;
        throw new Error(`injected rollback failure for ${target}`);
      }
      return fs.renameSync(source, destination);
    }
  } as unknown as PromotionFs;
}

test('promotion rolls all three targets back when any replacement fails', () => {
  const { root, assets, staging } = fixture();
  try {
    const result = promoteDemoAssets(root, staging, 'generation-1', withRenameFault(targetFor(assets, 'transcript')));
    assert.equal(result.status, 'failed');
    assert.equal(fs.readFileSync(targetFor(assets, 'gif'), 'utf8'), 'old gif\n');
    assert.equal(fs.readFileSync(targetFor(assets, 'transcript'), 'utf8'), 'old transcript\n');
    assert.equal(fs.readFileSync(targetFor(assets, 'sha256'), 'utf8'), 'old sha256\n');
    assert.equal(fs.existsSync(path.join(assets, '.demo-init.promotion.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted rollback remains recoverable from the promotion journal', () => {
  const { root, assets, staging } = fixture();
  const target = targetFor(assets, 'gif');
  try {
    const result = promoteDemoAssets(root, staging, 'generation-2', withRenameFault(target, true));
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
