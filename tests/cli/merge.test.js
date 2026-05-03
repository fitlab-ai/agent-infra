import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { filePath } from '../helpers.js';
import {
  detectSourceMode,
  extractField,
  extractTitle,
  formatBackupTimestamp,
  getTaskTimestamp,
  rebuildManifests,
  scanSourceTasks
} from '../../lib/merge.js';

function makeTempRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-merge-'));
  for (const section of ['active', 'blocked', 'completed', 'archive']) {
    fs.mkdirSync(path.join(repoDir, '.agents', 'workspace', section), { recursive: true });
  }
  return repoDir;
}

function makeTempWorkspace(repoDir, name = 'incoming-workspace') {
  const workspaceDir = path.join(repoDir, name);
  for (const section of ['active', 'blocked', 'completed', 'archive']) {
    fs.mkdirSync(path.join(workspaceDir, section), { recursive: true });
  }
  return workspaceDir;
}

function writeTask(rootDir, relativeDir, taskId, { title, type = 'feature', completedAt, updatedAt }) {
  const taskDir = path.join(rootDir, relativeDir, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'task.md'),
    [
      '---',
      `id: ${taskId}`,
      `type: ${type}`,
      `updated_at: ${updatedAt || completedAt}`,
      `completed_at: ${completedAt}`,
      '---',
      '',
      `# 任务：${title}`,
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(path.join(taskDir, 'note.txt'), `${taskId}\n`, 'utf8');
  return taskDir;
}

function writeFlatTask(rootDir, section, taskId, {
  title,
  type = 'feature',
  updatedAt,
  extraFiles = {},
  omitUpdatedAt = false
} = {}) {
  const taskDir = path.join(rootDir, section, taskId);
  const lines = [
    '---',
    `id: ${taskId}`,
    `type: ${type}`
  ];

  if (!omitUpdatedAt && updatedAt) {
    lines.push(`updated_at: ${updatedAt}`);
  }

  lines.push('---', '', `# 任务：${title || taskId}`, '', 'workspace task');

  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'task.md'), `${lines.join('\n')}\n`, 'utf8');

  for (const [name, content] of Object.entries(extraFiles)) {
    const filePath = path.join(taskDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  return taskDir;
}

function setTimestamp(targetPath, isoString) {
  const date = new Date(isoString);
  fs.utimesSync(targetPath, date, date);
}

function formatLocalTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + ' ' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(':') + `${sign}${pad(Math.floor(absoluteOffsetMinutes / 60))}:${pad(absoluteOffsetMinutes % 60)}`;
}

function read(relativePath) {
  return fs.readFileSync(relativePath, 'utf8');
}

test('merge copies new archived tasks and rebuilds manifests', () => {
  const repoDir = makeTempRepo();
  const sourceDir = path.join(repoDir, 'incoming-archive');

  try {
    writeTask(sourceDir, '2026/03/20', 'TASK-20260320-111111', {
      title: '同步归档',
      type: 'feature',
      completedAt: '2026-03-20 11:11:11'
    });

    const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceDir], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    const archiveRoot = path.join(repoDir, '.agents', 'workspace', 'archive');
    const taskPath = path.join(archiveRoot, '2026/03/20/TASK-20260320-111111');
    assert.ok(fs.existsSync(taskPath));
    assert.match(output, /Merged TASK-20260320-111111 -> 2026\/03\/20\/TASK-20260320-111111\//);
    assert.match(output, /- Merged: 1/);
    assert.match(read(path.join(archiveRoot, 'manifest.md')), /\| 2026 \| 1 \| \[2026\/manifest\.md\]\(2026\/manifest\.md\) \|/);
    assert.match(read(path.join(archiveRoot, '2026/03/manifest.md')), /\| TASK-20260320-111111 \| 同步归档 \| feature \| 2026-03-20 11:11:11 \| 2026\/03\/20\/TASK-20260320-111111\/ \|/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('merge skips existing task IDs without overwriting local archive', () => {
  const repoDir = makeTempRepo();
  const sourceDir = path.join(repoDir, 'incoming-archive');
  const archiveRoot = path.join(repoDir, '.agents', 'workspace', 'archive');

  try {
    writeTask(archiveRoot, '2026/03/21', 'TASK-20260321-222222', {
      title: '本地版本',
      completedAt: '2026-03-21 10:00:00'
    });
    writeTask(sourceDir, '2026/03/22', 'TASK-20260321-222222', {
      title: '远端版本',
      completedAt: '2026-03-22 10:00:00'
    });

    const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceDir], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    assert.match(output, /Skipped TASK-20260321-222222 \(already exists at 2026\/03\/21\/TASK-20260321-222222\/\)/);
    assert.match(output, /- Merged: 0/);
    assert.match(output, /- Skipped: 1/);
    assert.match(read(path.join(archiveRoot, '2026/03/21/TASK-20260321-222222/task.md')), /本地版本/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('merge reports mixed merged and skipped tasks', () => {
  const repoDir = makeTempRepo();
  const sourceDir = path.join(repoDir, 'incoming-archive');
  const archiveRoot = path.join(repoDir, '.agents', 'workspace', 'archive');

  try {
    writeTask(archiveRoot, '2026/03/11', 'TASK-20260311-000001', {
      title: '已存在任务',
      completedAt: '2026-03-11 09:00:00'
    });
    writeTask(sourceDir, '2026/03/11', 'TASK-20260311-000001', {
      title: '重复任务',
      completedAt: '2026-03-11 10:00:00'
    });
    writeTask(sourceDir, '2026/03/12', 'TASK-20260312-000002', {
      title: '新任务',
      completedAt: '2026-03-12 10:00:00'
    });

    const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceDir], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    assert.match(output, /Merged TASK-20260312-000002 -> 2026\/03\/12\/TASK-20260312-000002\//);
    assert.match(output, /Skipped TASK-20260311-000001 \(already exists at 2026\/03\/11\/TASK-20260311-000001\/\)/);
    assert.match(output, /- Merged: 1/);
    assert.match(output, /- Skipped: 1/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('merge handles an empty source archive without failing', () => {
  const repoDir = makeTempRepo();
  const sourceDir = path.join(repoDir, 'incoming-archive');
  fs.mkdirSync(sourceDir, { recursive: true });

  try {
    const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceDir], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    assert.match(output, /No archived tasks found in/);
    assert.match(output, /- Merged: 0/);
    assert.match(output, /- Skipped: 0/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('rebuildManifests matches month manifest format and ordering', () => {
  const repoDir = makeTempRepo();
  const archiveRoot = path.join(repoDir, '.agents', 'workspace', 'archive');

  try {
    writeTask(archiveRoot, '2026/03/10', 'TASK-20260310-000001', {
      title: '较早任务',
      type: 'bug',
      completedAt: '2026-03-10 08:00:00'
    });
    writeTask(archiveRoot, '2026/03/11', 'TASK-20260311-000002', {
      title: '较新任务 | 需要转义',
      type: 'feature',
      completedAt: '2026-03-11 08:00:00'
    });

    rebuildManifests(archiveRoot);

    const monthManifest = read(path.join(archiveRoot, '2026/03/manifest.md'));
    assert.match(monthManifest, /\| Task ID \| Title \| Type \| Completed \| Path \|/);
    assert.ok(
      monthManifest.indexOf('TASK-20260311-000002') < monthManifest.indexOf('TASK-20260310-000001'),
      'newer tasks should appear first'
    );
    assert.match(monthManifest, /\| TASK-20260311-000002 \| 较新任务 \\| 需要转义 \| feature \| 2026-03-11 08:00:00 \| 2026\/03\/11\/TASK-20260311-000002\/ \|/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('rebuildManifests generates root, year, and month manifests', () => {
  const repoDir = makeTempRepo();
  const archiveRoot = path.join(repoDir, '.agents', 'workspace', 'archive');

  try {
    writeTask(archiveRoot, '2025/12/31', 'TASK-20251231-000001', {
      title: '年末任务',
      completedAt: '2025-12-31 23:59:59'
    });
    writeTask(archiveRoot, '2026/01/01', 'TASK-20260101-000001', {
      title: '新年任务',
      completedAt: '2026-01-01 00:00:01'
    });

    rebuildManifests(archiveRoot);

    assert.ok(fs.existsSync(path.join(archiveRoot, 'manifest.md')));
    assert.ok(fs.existsSync(path.join(archiveRoot, '2025/manifest.md')));
    assert.ok(fs.existsSync(path.join(archiveRoot, '2026/manifest.md')));
    assert.ok(fs.existsSync(path.join(archiveRoot, '2025/12/manifest.md')));
    assert.ok(fs.existsSync(path.join(archiveRoot, '2026/01/manifest.md')));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('rebuildManifests ignores invalid task-like directories', () => {
  const repoDir = makeTempRepo();
  const archiveRoot = path.join(repoDir, '.agents', 'workspace', 'archive');

  try {
    writeTask(archiveRoot, '2026/02/01', 'TASK-20260201-000001', {
      title: '合法任务',
      completedAt: '2026-02-01 08:00:00'
    });
    fs.mkdirSync(path.join(archiveRoot, '2026/02/01/TASK-invalid'), { recursive: true });

    rebuildManifests(archiveRoot);

    const monthManifest = read(path.join(archiveRoot, '2026/02/manifest.md'));
    assert.match(monthManifest, /TASK-20260201-000001/);
    assert.doesNotMatch(monthManifest, /TASK-invalid/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('frontmatter helpers and source scanning parse archived task metadata', () => {
  const repoDir = makeTempRepo();
  const sourceDir = path.join(repoDir, 'incoming-archive');

  try {
    writeTask(sourceDir, 'nested/archive/2026/03/09', 'TASK-20260309-123456', {
      title: 'Task: 管道 | 转义',
      type: 'bug',
      completedAt: '2026-03-09 12:34:56',
      updatedAt: '2026-03-10 09:00:00'
    });

    const content = read(path.join(sourceDir, 'nested/archive/2026/03/09/TASK-20260309-123456/task.md'));
    assert.equal(extractField(content, 'type'), 'bug');
    assert.equal(extractField(content, 'missing'), null);
    assert.equal(extractTitle(content), '管道 \\| 转义');

    const tasks = scanSourceTasks(sourceDir);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].taskId, 'TASK-20260309-123456');
    assert.equal(tasks[0].relativePath, '2026/03/09/TASK-20260309-123456/');
    assert.equal(tasks[0].completedAt, '2026-03-09 12:34:56');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('detectSourceMode distinguishes workspace and legacy archive sources', () => {
  const repoDir = makeTempRepo();
  const workspaceDir = makeTempWorkspace(repoDir);
  const archiveDir = path.join(repoDir, 'legacy-archive');

  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    writeTask(archiveDir, '2026/04/09', 'TASK-20260409-010101', {
      title: 'legacy archive task',
      completedAt: '2026-04-09 01:01:01'
    });

    assert.equal(detectSourceMode(workspaceDir), 'workspace');
    assert.equal(detectSourceMode(archiveDir), 'legacy-archive');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('getTaskTimestamp prefers frontmatter updated_at over file mtime', () => {
  const repoDir = makeTempRepo();
  const workspaceDir = path.join(repoDir, '.agents', 'workspace');

  try {
    const taskDir = writeFlatTask(workspaceDir, 'active', 'TASK-20260409-020202', {
      title: 'frontmatter wins',
      updatedAt: '2026-04-09T02:02:02+08:00'
    });

    setTimestamp(path.join(taskDir, 'task.md'), '2026-04-09T10:00:00Z');

    const timestamp = getTaskTimestamp(taskDir);
    assert.deepEqual(timestamp, {
      value: '2026-04-09T02:02:02+08:00',
      source: 'frontmatter'
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('getTaskTimestamp falls back to task.md mtime when updated_at is absent', () => {
  const repoDir = makeTempRepo();
  const workspaceDir = path.join(repoDir, '.agents', 'workspace');

  try {
    const taskDir = writeFlatTask(workspaceDir, 'active', 'TASK-20260409-030303', {
      title: 'mtime fallback',
      omitUpdatedAt: true
    });

    setTimestamp(path.join(taskDir, 'task.md'), '2026-04-09T03:03:03Z');

    const timestamp = getTaskTimestamp(taskDir);
    assert.equal(timestamp.source, 'task-mtime');
    assert.equal(timestamp.value, formatLocalTimestamp(new Date('2026-04-09T03:03:03Z')));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('getTaskTimestamp falls back to latest file mtime when task.md is missing', () => {
  const repoDir = makeTempRepo();
  const taskDir = path.join(repoDir, 'orphan-task');

  try {
    fs.mkdirSync(path.join(taskDir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'notes', 'detail.txt'), 'detail\n', 'utf8');
    setTimestamp(path.join(taskDir, 'notes', 'detail.txt'), '2026-04-09T04:04:04Z');

    const timestamp = getTaskTimestamp(taskDir);
    assert.equal(timestamp.source, 'dir-mtime');
    assert.equal(timestamp.value, formatLocalTimestamp(new Date('2026-04-09T04:04:04Z')));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('formatBackupTimestamp uses local wall-clock time', () => {
  const date = new Date('2026-04-09T10:00:00Z');
  const expected = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('') + `-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;

  assert.equal(formatBackupTimestamp(date), expected);
});

test('merge workspace copies new mutable tasks and preserves archive behavior', () => {
  const repoDir = makeTempRepo();
  const sourceWorkspace = makeTempWorkspace(repoDir);

  try {
    writeFlatTask(sourceWorkspace, 'active', 'TASK-20260409-111111', {
      title: 'new active task',
      updatedAt: '2026-04-09 11:11:11'
    });
    writeTask(path.join(sourceWorkspace, 'archive'), '2026/04/09', 'TASK-20260409-121212', {
      title: 'archived task',
      completedAt: '2026-04-09 12:12:12'
    });

    const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceWorkspace], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    assert.ok(fs.existsSync(path.join(repoDir, '.agents/workspace/active/TASK-20260409-111111/task.md')));
    assert.ok(fs.existsSync(path.join(repoDir, '.agents/workspace/archive/2026/04/09/TASK-20260409-121212/task.md')));
    assert.match(output, /Active\s+\(.agents\/workspace\/active\/\):/);
    assert.match(output, /✓ Copied\s+: 1/);
    assert.match(output, /Archive\s+\(.agents\/workspace\/archive\/\):/);
    assert.match(output, /TASK-20260409-111111\s+active\s+copied/);
    assert.match(output, /TASK-20260409-121212\s+archive\s+copied/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('merge workspace updates same-section task when source is newer and creates backup', () => {
  const repoDir = makeTempRepo();
  const sourceWorkspace = makeTempWorkspace(repoDir);
  const localWorkspace = path.join(repoDir, '.agents', 'workspace');

  try {
    writeFlatTask(localWorkspace, 'active', 'TASK-20260409-131313', {
      title: 'local older',
      updatedAt: '2026-04-09 13:00:00',
      extraFiles: { 'note.txt': 'local\n' }
    });
    writeFlatTask(sourceWorkspace, 'active', 'TASK-20260409-131313', {
      title: 'source newer',
      updatedAt: '2026-04-09 13:13:13',
      extraFiles: { 'note.txt': 'source\n' }
    });

    const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceWorkspace], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    assert.match(read(path.join(localWorkspace, 'active/TASK-20260409-131313/task.md')), /source newer/);
    assert.equal(read(path.join(localWorkspace, 'active/TASK-20260409-131313/note.txt')), 'source\n');
    assert.match(output, /↑ Updated\s+: 1/);
    assert.match(output, /TASK-20260409-131313\s+active\s+updated \(source newer: 2026-04-09 13:13:13 > 2026-04-09 13:00:00\)/);

    const backupRoot = path.join(repoDir, '.agents', 'workspace', '.merge-backup');
    const backupBatches = fs.readdirSync(backupRoot);
    assert.equal(backupBatches.length, 1);
    assert.match(
      read(path.join(backupRoot, backupBatches[0], 'active/TASK-20260409-131313/task.md')),
      /local older/
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('merge workspace skips task when local version is newer', () => {
  const repoDir = makeTempRepo();
  const sourceWorkspace = makeTempWorkspace(repoDir);
  const localWorkspace = path.join(repoDir, '.agents', 'workspace');

  try {
    writeFlatTask(localWorkspace, 'blocked', 'TASK-20260409-141414', {
      title: 'local newer',
      updatedAt: '2026-04-09 14:14:14'
    });
    writeFlatTask(sourceWorkspace, 'blocked', 'TASK-20260409-141414', {
      title: 'source older',
      updatedAt: '2026-04-09 14:00:00'
    });

    const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceWorkspace], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    assert.match(read(path.join(localWorkspace, 'blocked/TASK-20260409-141414/task.md')), /local newer/);
    assert.match(output, /⊘ Skipped\s+: 1/);
    assert.match(output, /TASK-20260409-141414\s+blocked\s+skipped \(local newer: 2026-04-09 14:14:14 > 2026-04-09 14:00:00\)/);
    assert.equal(fs.existsSync(path.join(localWorkspace, '.merge-backup')), false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('merge workspace moves task across sections when source section is newer', () => {
  const repoDir = makeTempRepo();
  const sourceWorkspace = makeTempWorkspace(repoDir);
  const localWorkspace = path.join(repoDir, '.agents', 'workspace');

  try {
    writeFlatTask(localWorkspace, 'active', 'TASK-20260409-151515', {
      title: 'still active locally',
      updatedAt: '2026-04-09 15:00:00'
    });
    writeFlatTask(sourceWorkspace, 'completed', 'TASK-20260409-151515', {
      title: 'completed on source',
      updatedAt: '2026-04-09 15:15:15'
    });

    const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceWorkspace], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    assert.equal(fs.existsSync(path.join(localWorkspace, 'active/TASK-20260409-151515')), false);
    assert.ok(fs.existsSync(path.join(localWorkspace, 'completed/TASK-20260409-151515/task.md')));
    assert.match(read(path.join(localWorkspace, 'completed/TASK-20260409-151515/task.md')), /completed on source/);
    assert.match(output, /⇄ Moved\s+: 1/);
    assert.match(output, /TASK-20260409-151515\s+active→completed\s+moved \(source newer: 2026-04-09 15:15:15 > 2026-04-09 15:00:00\)/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('merge workspace keeps local section when timestamps are equal across sections', () => {
  const repoDir = makeTempRepo();
  const sourceWorkspace = makeTempWorkspace(repoDir);
  const localWorkspace = path.join(repoDir, '.agents', 'workspace');

  try {
    writeFlatTask(localWorkspace, 'blocked', 'TASK-20260409-161616', {
      title: 'blocked locally',
      updatedAt: '2026-04-09 16:16:16'
    });
    writeFlatTask(sourceWorkspace, 'completed', 'TASK-20260409-161616', {
      title: 'completed remotely',
      updatedAt: '2026-04-09 16:16:16'
    });

    const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceWorkspace], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    assert.ok(fs.existsSync(path.join(localWorkspace, 'blocked/TASK-20260409-161616/task.md')));
    assert.equal(fs.existsSync(path.join(localWorkspace, 'completed/TASK-20260409-161616')), false);
    assert.match(output, /TASK-20260409-161616\s+blocked\s+skipped \(same timestamp: 2026-04-09 16:16:16\)/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('merge workspace compares task.md mtime when updated_at is missing', () => {
  const repoDir = makeTempRepo();
  const sourceWorkspace = makeTempWorkspace(repoDir);
  const localWorkspace = path.join(repoDir, '.agents', 'workspace');

  try {
    const localTaskDir = writeFlatTask(localWorkspace, 'active', 'TASK-20260409-171717', {
      title: 'local from mtime',
      omitUpdatedAt: true,
      extraFiles: { 'note.txt': 'local\n' }
    });
    const sourceTaskDir = writeFlatTask(sourceWorkspace, 'active', 'TASK-20260409-171717', {
      title: 'source from mtime',
      omitUpdatedAt: true,
      extraFiles: { 'note.txt': 'source\n' }
    });

    setTimestamp(path.join(localTaskDir, 'task.md'), '2026-04-09T17:00:00Z');
    setTimestamp(path.join(sourceTaskDir, 'task.md'), '2026-04-09T17:17:17Z');

    execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceWorkspace], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    assert.match(read(path.join(localWorkspace, 'active/TASK-20260409-171717/task.md')), /source from mtime/);
    assert.equal(read(path.join(localWorkspace, 'active/TASK-20260409-171717/note.txt')), 'source\n');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('merge workspace treats local frontmatter and source mtime for the same instant as equal', () => {
  const repoDir = makeTempRepo();
  const sourceWorkspace = makeTempWorkspace(repoDir);
  const localWorkspace = path.join(repoDir, '.agents', 'workspace');

  try {
    const instant = new Date('2026-04-09T10:00:00Z');
    writeFlatTask(localWorkspace, 'active', 'TASK-20260409-181818', {
      title: 'local frontmatter timestamp',
      updatedAt: formatLocalTimestamp(instant)
    });
    const sourceTaskDir = writeFlatTask(sourceWorkspace, 'active', 'TASK-20260409-181818', {
      title: 'source mtime timestamp',
      omitUpdatedAt: true
    });
    setTimestamp(path.join(sourceTaskDir, 'task.md'), instant.toISOString());

    const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceWorkspace], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    assert.match(read(path.join(localWorkspace, 'active/TASK-20260409-181818/task.md')), /local frontmatter timestamp/);
    assert.match(output, /TASK-20260409-181818\s+active\s+skipped \(same timestamp:/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('merge workspace treats source frontmatter and local mtime for the same instant as equal', () => {
  const repoDir = makeTempRepo();
  const sourceWorkspace = makeTempWorkspace(repoDir);
  const localWorkspace = path.join(repoDir, '.agents', 'workspace');

  try {
    const instant = new Date('2026-04-09T10:00:00Z');
    const localTaskDir = writeFlatTask(localWorkspace, 'active', 'TASK-20260409-191919', {
      title: 'local mtime timestamp',
      omitUpdatedAt: true
    });
    setTimestamp(path.join(localTaskDir, 'task.md'), instant.toISOString());
    writeFlatTask(sourceWorkspace, 'active', 'TASK-20260409-191919', {
      title: 'source frontmatter timestamp',
      updatedAt: formatLocalTimestamp(instant)
    });

    const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceWorkspace], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    assert.match(read(path.join(localWorkspace, 'active/TASK-20260409-191919/task.md')), /local mtime timestamp/);
    assert.match(output, /TASK-20260409-191919\s+active\s+skipped \(same timestamp:/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('merge legacy archive mode remains backward compatible and prints deprecation hint', () => {
  const repoDir = makeTempRepo();
  const sourceDir = path.join(repoDir, 'incoming-archive');

  try {
    writeTask(sourceDir, '2026/04/01', 'TASK-20260401-010101', {
      title: 'legacy task',
      completedAt: '2026-04-01 01:01:01'
    });

    const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'merge', sourceDir], {
      cwd: repoDir,
      encoding: 'utf8'
    });

    assert.match(output, /Detected legacy archive source/);
    assert.match(output, /Merged TASK-20260401-010101 -> 2026\/04\/01\/TASK-20260401-010101\//);
    assert.match(output, /- Merged: 1/);
    assert.match(output, /Backup contains 0 task\(s\)/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('cli help advertises workspace merge scope', () => {
  const output = execFileSync(process.execPath, [filePath('bin/cli.js'), 'help'], {
    encoding: 'utf8'
  });

  assert.match(output, /Merge tasks from another workspace directory \(active\/blocked\/completed\/archive\)/);
});
