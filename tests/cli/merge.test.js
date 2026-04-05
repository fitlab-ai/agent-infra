import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { filePath } from '../helpers.js';
import {
  extractField,
  extractTitle,
  rebuildManifests,
  scanSourceTasks
} from '../../lib/merge.js';

function makeTempRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-merge-'));
  fs.mkdirSync(path.join(repoDir, '.agents', 'workspace', 'archive'), { recursive: true });
  return repoDir;
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
