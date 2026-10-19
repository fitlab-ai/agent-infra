import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { onPlatforms } from '../../helpers.ts';
import { discoverTaskWorkspaceSources, migrateProjectTaskWorkspace, migrateTaskWorkspace, splitDestinationPath } from '../../../lib/task/workspace-migration.ts';

test('destination path segmentation keeps Windows drive and UNC roots separate', () => {
  const drive = splitDestinationPath('C:\\Users\\fixture\\.agent-infra\\task-workspaces\\demo', path.win32);
  assert.equal(drive.root, 'C:\\');
  assert.deepEqual(drive.segments, ['Users', 'fixture', '.agent-infra', 'task-workspaces', 'demo']);
  assert.equal(path.win32.join(drive.root, ...drive.segments.slice(0, 2)), 'C:\\Users\\fixture');

  const unc = splitDestinationPath('\\\\server\\share\\Users\\fixture\\.agent-infra\\task-workspaces\\demo', path.win32);
  assert.equal(unc.root, '\\\\server\\share\\');
  assert.deepEqual(unc.segments, ['Users', 'fixture', '.agent-infra', 'task-workspaces', 'demo']);
  assert.equal(path.win32.join(unc.root, ...unc.segments.slice(0, 2)), '\\\\server\\share\\Users\\fixture');
});

test('migration unions distinct task data and preserves raw bytes and symlink text', onPlatforms('linux', 'darwin'), (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workspace-migration-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const first = path.join(temp, 'worktree-a', '.agents', 'workspace');
  const second = path.join(temp, 'worktree-b', '.agents', 'workspace');
  const target = path.join(temp, 'home', '.agent-infra', 'task-workspaces', 'demo');
  fs.mkdirSync(path.join(first, 'active', 'TASK-A'), { recursive: true });
  fs.mkdirSync(path.join(first, 'active', 'empty-dir'), { recursive: true });
  fs.mkdirSync(path.join(first, 'active', '隐藏'), { recursive: true });
  fs.mkdirSync(path.join(second, 'archive', '2026'), { recursive: true });
  const bytes = Buffer.from([0, 255, 1, 128]);
  fs.writeFileSync(path.join(first, 'active', 'TASK-A', 'task.md'), bytes);
  fs.writeFileSync(path.join(first, 'active', '.hidden'), Buffer.from([255, 0, 128]));
  fs.writeFileSync(path.join(first, 'active', '隐藏', '记录.md'), '原始 UTF-8 字节\n');
  fs.writeFileSync(path.join(second, 'archive', '2026', 'note'), '历史\n');
  fs.mkdirSync(path.join(first, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(first, 'README.md'), 'leave legacy root material in place\n');
  fs.writeFileSync(path.join(first, 'logs', 'session.md'), 'out of scope\n');
  fs.symlinkSync('../active/TASK-A', path.join(first, 'active', 'task-link'));
  const result = migrateTaskWorkspace({ sources: [first, second], destination: target, migrationId: 'fixture-1' });
  assert.equal(result.status, 'migrated');
  assert.deepEqual(fs.readFileSync(path.join(target, 'active', 'TASK-A', 'task.md')), bytes);
  assert.equal(fs.readlinkSync(path.join(target, 'active', 'task-link')), '../active/TASK-A');
  assert.equal(fs.existsSync(path.join(target, 'active', 'empty-dir')), true);
  assert.deepEqual(fs.readFileSync(path.join(target, 'active', '.hidden')), Buffer.from([255, 0, 128]));
  assert.equal(fs.readFileSync(path.join(target, 'active', '隐藏', '记录.md'), 'utf8'), '原始 UTF-8 字节\n');
  assert.equal(fs.existsSync(path.join(first, 'active', 'TASK-A', 'task.md')), false);
  assert.equal(fs.readFileSync(path.join(first, 'README.md'), 'utf8'), 'leave legacy root material in place\n');
  assert.equal(fs.readFileSync(path.join(first, 'logs', 'session.md'), 'utf8'), 'out of scope\n');
  assert.equal(fs.readFileSync(path.join(target, 'archive', '2026', 'note'), 'utf8'), '历史\n');
  assert.equal(migrateTaskWorkspace({ sources: [first, second], destination: target, migrationId: 'fixture-1' }).status, 'already-migrated');
});

test('migration rejects short-id byte and entry-type conflicts before touching either source', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workspace-registry-conflict-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const first = path.join(temp, 'first', '.agents', 'workspace');
  const second = path.join(temp, 'second', '.agents', 'workspace');
  fs.mkdirSync(path.join(first, 'active'), { recursive: true });
  fs.mkdirSync(path.join(second, 'active'), { recursive: true });
  const registryA = Buffer.from('{"version":1,"ids":{"01":"TASK-A"}}\n');
  const registryB = Buffer.from('{"version":1,"ids":{"01":"TASK-B"}}\n');
  fs.writeFileSync(path.join(first, 'active', '.short-ids.json'), registryA);
  fs.writeFileSync(path.join(second, 'active', '.short-ids.json'), registryB);
  assert.throws(() => migrateTaskWorkspace({
    sources: [first, second], destination: path.join(temp, 'registry-target'), migrationId: 'registry-conflict'
  }), /migration conflict at active\/.short-ids\.json/u);
  assert.deepEqual(fs.readFileSync(path.join(first, 'active', '.short-ids.json')), registryA);
  assert.deepEqual(fs.readFileSync(path.join(second, 'active', '.short-ids.json')), registryB);

  fs.rmSync(path.join(first, 'active', '.short-ids.json'));
  fs.rmSync(path.join(second, 'active', '.short-ids.json'));
  fs.mkdirSync(path.join(first, 'blocked', 'same'), { recursive: true });
  fs.mkdirSync(path.join(second, 'blocked'), { recursive: true });
  fs.writeFileSync(path.join(second, 'blocked', 'same'), 'file');
  assert.throws(() => migrateTaskWorkspace({
    sources: [first, second], destination: path.join(temp, 'type-target'), migrationId: 'type-conflict'
  }), /migration conflict at blocked\/same/u);
  assert.equal(fs.statSync(path.join(first, 'blocked', 'same')).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(second, 'blocked', 'same'), 'utf8'), 'file');
});

test('migration rejects conflicting paths before changing sources or destination', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workspace-conflict-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const a = path.join(temp, 'a', '.agents', 'workspace');
  const b = path.join(temp, 'b', '.agents', 'workspace');
  const target = path.join(temp, 'target');
  fs.mkdirSync(path.join(a, 'active'), { recursive: true });
  fs.mkdirSync(path.join(b, 'active'), { recursive: true });
  fs.writeFileSync(path.join(a, 'active', 'same'), 'one');
  fs.writeFileSync(path.join(b, 'active', 'same'), 'two');
  assert.throws(() => migrateTaskWorkspace({ sources: [a, b], destination: target, migrationId: 'fixture-conflict' }), /migration conflict/u);
  assert.equal(fs.readFileSync(path.join(a, 'active', 'same'), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(b, 'active', 'same'), 'utf8'), 'two');
  assert.equal(fs.existsSync(target), false);
});

test('migration resumes after a source item is deleted before its journal update', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workspace-resume-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'repo', '.agents', 'workspace');
  const target = path.join(temp, 'home', '.agent-infra', 'task-workspaces', 'resume');
  fs.mkdirSync(path.join(source, 'active', 'TASK-A'), { recursive: true });
  fs.writeFileSync(path.join(source, 'active', 'TASK-A', 'task.md'), 'preserve all source bytes\n');
  fs.mkdirSync(path.join(source, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(source, 'logs', 'untouched.md'), 'outside migration scope\n');

  assert.throws(() => migrateTaskWorkspace({ sources: [source], destination: target, migrationId: 'resume-1' }, {
    onStep: (step, relativePath) => {
      if (step === 'source-item-deleted-before-journal' && relativePath === 'active/TASK-A/task.md') throw new Error('simulated interruption');
    }
  }), /simulated interruption/u);
  assert.equal(fs.existsSync(path.join(target, 'active', 'TASK-A', 'task.md')), true);
  assert.equal(fs.existsSync(path.join(source, 'active', 'TASK-A', 'task.md')), false);
  assert.equal(fs.existsSync(path.join(source, 'logs', 'untouched.md')), true);

  assert.equal(migrateTaskWorkspace({ sources: [source], destination: target, migrationId: 'resume-1' }).status, 'already-migrated');
  assert.equal(fs.readFileSync(path.join(target, 'active', 'TASK-A', 'task.md'), 'utf8'), 'preserve all source bytes\n');
  assert.equal(fs.readFileSync(path.join(source, 'logs', 'untouched.md'), 'utf8'), 'outside migration scope\n');
});

test('migration resumes after interruption at every durable copy and cleanup boundary', (t) => {
  const interruptionPoints = [
    'manifest-frozen',
    'staging-entry-copied',
    'staging-verified',
    'destination-committed',
    'source-item-removing',
    'source-item-deleted-before-journal',
    'source-item-removed'
  ] as const;
  for (const [index, interruptionPoint] of interruptionPoints.entries()) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `task-workspace-interrupt-${index}-`));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const source = path.join(temp, 'repo', '.agents', 'workspace');
    const target = path.join(temp, 'home', '.agent-infra', 'task-workspaces', 'resume');
    const bytes = Buffer.from([0, 255, 10, 128]);
    fs.mkdirSync(path.join(source, 'active', 'TASK-A'), { recursive: true });
    fs.writeFileSync(path.join(source, 'active', 'TASK-A', 'task.md'), bytes);
    let interrupted = false;
    assert.throws(() => migrateTaskWorkspace({ sources: [source], destination: target, migrationId: 'interrupt-1' }, {
      onStep: (step) => {
        if (!interrupted && step === interruptionPoint) {
          interrupted = true;
          throw new Error(`interrupted at ${step}`);
        }
      }
    }), new RegExp(`interrupted at ${interruptionPoint}`, 'u'));
    assert.equal(interrupted, true);
    const resumed = migrateTaskWorkspace({ sources: [source], destination: target, migrationId: 'interrupt-1' });
    assert.equal(resumed.status, 'already-migrated');
    assert.deepEqual(fs.readFileSync(path.join(target, 'active', 'TASK-A', 'task.md')), bytes);
    assert.equal(fs.existsSync(path.join(source, 'active', 'TASK-A', 'task.md')), false);
  }
});

test('migration stops source cleanup when the committed destination changes between deletions', onPlatforms('linux', 'darwin'), (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workspace-target-change-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'repo', '.agents', 'workspace');
  const target = path.join(temp, 'home', '.agent-infra', 'task-workspaces', 'demo');
  fs.mkdirSync(path.join(source, 'active'), { recursive: true });
  fs.writeFileSync(path.join(source, 'active', 'a'), 'original-a');
  fs.writeFileSync(path.join(source, 'active', 'b'), 'original-b');

  assert.throws(() => migrateTaskWorkspace({ sources: [source], destination: target, migrationId: 'target-change' }, {
    onStep: (step, relativePath) => {
      if (step === 'source-item-removed' && relativePath === 'active/b') {
        fs.writeFileSync(path.join(target, 'active', 'a'), 'corrupted-a');
      }
    }
  }), /destination differs from frozen manifest/u);
  assert.equal(fs.existsSync(path.join(source, 'active', 'a')), true);
  assert.equal(fs.readFileSync(path.join(source, 'active', 'a'), 'utf8'), 'original-a');
  assert.equal(fs.readFileSync(path.join(target, 'active', 'a'), 'utf8'), 'corrupted-a');
});

test('migration rejects symlinked destination ancestors and replaced roots before source cleanup', onPlatforms('linux', 'darwin'), (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workspace-destination-link-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'repo', '.agents', 'workspace');
  fs.mkdirSync(path.join(source, 'active'), { recursive: true });
  const originalBytes = Buffer.from([0, 255, 10, 128]);
  fs.writeFileSync(path.join(source, 'active', 'bytes'), originalBytes);

  const home = path.join(temp, 'home');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(outside, 'task-workspaces'), { recursive: true });
  fs.symlinkSync(outside, path.join(home, '.agent-infra'));
  const aliasedDestination = path.join(home, '.agent-infra', 'task-workspaces', 'demo');
  assert.throws(() => migrateTaskWorkspace({
    sources: [source], destination: aliasedDestination, migrationId: 'ancestor-link'
  }), /symlink|canonical/u);
  assert.deepEqual(fs.readFileSync(path.join(source, 'active', 'bytes')), originalBytes);
  assert.equal(fs.existsSync(path.join(outside, 'task-workspaces', 'demo')), false);

  const target = path.join(temp, 'home-two', '.agent-infra', 'task-workspaces', 'resume');
  assert.throws(() => migrateTaskWorkspace({ sources: [source], destination: target, migrationId: 'root-link' }, {
    onStep: (step) => { if (step === 'destination-committed') throw new Error('simulated interruption'); }
  }), /simulated interruption/u);
  const moved = `${target}.moved`;
  fs.renameSync(target, moved);
  fs.symlinkSync(moved, target);
  assert.throws(() => migrateTaskWorkspace({ sources: [source], destination: target, migrationId: 'root-link' }), /symlink|canonical/u);
  assert.deepEqual(fs.readFileSync(path.join(source, 'active', 'bytes')), originalBytes);
  assert.deepEqual(fs.readFileSync(path.join(moved, 'active', 'bytes')), originalBytes);
});

test('project migration rejects a managed-root symlink when project repeats the root name', onPlatforms('linux', 'darwin'), (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workspace-repeated-root-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'repo');
  const home = path.join(temp, 'home');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(path.join(repo, '.agents', 'workspace', 'active'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(outside, 'task-workspaces'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.agents', '.airc.json'), JSON.stringify({ project: '.agent-infra' }));
  const sourceBytes = Buffer.from([0, 255, 10, 128]);
  fs.writeFileSync(path.join(repo, '.agents', 'workspace', 'active', 'a'), sourceBytes);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.symlinkSync(outside, path.join(home, '.agent-infra'));

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.throws(() => migrateProjectTaskWorkspace(repo, 'repeated-root'), /symlink|canonical/u);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }

  assert.deepEqual(fs.readFileSync(path.join(repo, '.agents', 'workspace', 'active', 'a')), sourceBytes);
  assert.equal(fs.existsSync(path.join(outside, 'task-workspaces', '.agent-infra')), false);
});

test('migration rejects a changed source set or source tree before destination commit', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workspace-source-change-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'repo', '.agents', 'workspace');
  const addedSource = path.join(temp, 'new-worktree', '.agents', 'workspace');
  const target = path.join(temp, 'home', '.agent-infra', 'task-workspaces', 'safe');
  fs.mkdirSync(path.join(source, 'active'), { recursive: true });
  fs.writeFileSync(path.join(source, 'active', 'task.md'), 'frozen bytes\n');
  let discoveryCount = 0;
  assert.throws(() => migrateTaskWorkspace({ sources: [source], destination: target, migrationId: 'source-set-1' }, {
    discoverSources: () => ++discoveryCount === 1 ? [source] : [source, addedSource]
  }), /source set changed after it was frozen/u);
  assert.equal(fs.readFileSync(path.join(source, 'active', 'task.md'), 'utf8'), 'frozen bytes\n');
  assert.equal(fs.existsSync(target), false);

  const changedTarget = path.join(temp, 'home', '.agent-infra', 'task-workspaces', 'changed-tree');
  assert.throws(() => migrateTaskWorkspace({ sources: [source], destination: changedTarget, migrationId: 'source-tree-1' }, {
    onStep: (step) => {
      if (step === 'staging-verified') fs.writeFileSync(path.join(source, 'active', 'new.md'), 'concurrent write\n');
    }
  }), /source changed before destination commit/u);
  assert.equal(fs.existsSync(changedTarget), false);
  assert.equal(fs.readFileSync(path.join(source, 'active', 'task.md'), 'utf8'), 'frozen bytes\n');
  assert.equal(fs.readFileSync(path.join(source, 'active', 'new.md'), 'utf8'), 'concurrent write\n');
});

test('migration discovery freezes same-project registered Git worktrees only', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-workspace-worktrees-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'repo');
  const other = path.join(temp, 'other');
  fs.mkdirSync(path.join(repo, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.agents', '.airc.json'), JSON.stringify({ project: 'same-project' }));
  const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'Fixture']);
  git(['add', '.agents/.airc.json']);
  git(['commit', '-qm', 'fixture']);
  git(['worktree', 'add', '-qb', 'fixture-branch', other]);
  for (const root of [repo, other]) fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active'), { recursive: true });
  const sources = discoverTaskWorkspaceSources(repo);
  assert.deepEqual(sources.sort(), [
    fs.realpathSync.native(path.join(repo, '.agents', 'workspace')),
    fs.realpathSync.native(path.join(other, '.agents', 'workspace'))
  ].sort());
});
