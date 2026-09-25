#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const workspace = path.join(repoRoot, '.agents/workspace');
const archive = path.join(workspace, 'archive');
const marker = path.join(workspace, '.archive-migration-state.json');
const lock = path.join(workspace, '.archive-operation-lock');
const idPattern = /^TASK-\d{8}-\d{6}$/;

function fail(message) { throw new Error(message); }
function shaFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function walkFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.includes('\n') || entry.name.includes('\r')) fail(`newline path is not supported: ${path.join(dir, entry.name)}`);
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fail(`symbolic link is not supported: ${target}`);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) files.push(target);
      else fail(`special file is not supported: ${target}`);
    }
  };
  walk(root);
  return files.sort((a, b) => Buffer.compare(Buffer.from(path.relative(root, a).split(path.sep).join('/')), Buffer.from(path.relative(root, b).split(path.sep).join('/'))));
}
function snapshot(root) {
  return walkFiles(root).map((file) => [path.relative(root, file).split(path.sep).join('/'), shaFile(file)]);
}
function sameSnapshot(left, right) { return JSON.stringify(snapshot(left)) === JSON.stringify(snapshot(right)); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) fail(`${command} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout;
}
function acquireLock() {
  fs.mkdirSync(workspace, { recursive: true });
  try {
    const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid < 1) fail(`invalid archive lock pid: ${lock}`);
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      fs.rmSync(lock, { recursive: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`, { flag: 'wx' }); }
  catch { fail(`archive operation lock exists: ${lock}`); }
  return () => fs.rmSync(lock, { recursive: true, force: true });
}
function assertNoMarker() {
  if (fs.existsSync(marker)) fail(`migration marker exists; use --restore <backup.tar>: ${marker}`);
}
function listTasks() {
  if (!fs.existsSync(archive)) return [];
  const tasks = [];
  const seen = new Set();
  for (const y of fs.readdirSync(archive, { withFileTypes: true })) {
    if (y.name === 'manifest.md' && y.isFile()) continue;
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) fail(`unsupported archive entry: ${path.join(archive, y.name)}`);
    for (const m of fs.readdirSync(path.join(archive, y.name), { withFileTypes: true })) {
      if (m.name === 'manifest.md' && m.isFile()) continue;
      if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) fail(`unsupported archive entry: ${path.join(archive, y.name, m.name)}`);
      for (const d of fs.readdirSync(path.join(archive, y.name, m.name), { withFileTypes: true })) {
        if (d.name === 'manifest.md' && d.isFile()) continue;
        if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) fail(`unsupported archive entry: ${path.join(archive, y.name, m.name, d.name)}`);
        const parsedDate = new Date(`${y.name}-${m.name}-${d.name}T00:00:00Z`);
        if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== `${y.name}-${m.name}-${d.name}`) fail(`invalid archive date path: ${y.name}/${m.name}/${d.name}`);
        for (const t of fs.readdirSync(path.join(archive, y.name, m.name, d.name), { withFileTypes: true })) {
          if (!t.isDirectory() || !idPattern.test(t.name)) fail(`unsupported task entry: ${t.name}`);
          if (seen.has(t.name)) fail(`duplicate task ID: ${t.name}`);
          seen.add(t.name);
          const taskDir = path.join(archive, y.name, m.name, d.name, t.name);
          if (!fs.existsSync(path.join(taskDir, 'task.md')) || fs.existsSync(path.join(taskDir, 'local'))) fail(`unsupported or mixed archive layout: ${taskDir}`);
          const taskFiles = walkFiles(taskDir);
          if (taskFiles.some((file) => path.basename(file) === 'manifest.md')) fail(`manifest.md is not allowed inside a TASK: ${taskDir}`);
          tasks.push(taskDir);
        }
      }
    }
  }
  return tasks;
}
function writeContentsHash(localDir) {
  const content = walkFiles(localDir).filter((f) => path.basename(f) !== 'contents.sha256')
    .map((f) => `${shaFile(f)}  ${path.relative(localDir, f).split(path.sep).join('/')}`).join('\n') + '\n';
  fs.writeFileSync(path.join(localDir, 'contents.sha256'), content, { flag: 'wx' });
  const expected = content.trimEnd().split('\n').filter(Boolean);
  const actual = fs.readFileSync(path.join(localDir, 'contents.sha256'), 'utf8').trimEnd().split('\n').filter(Boolean);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) fail(`contents.sha256 verification failed: ${localDir}`);
}
function validateFinal(tasks) {
  for (const taskDir of tasks) {
    const local = path.join(taskDir, 'local');
    if (!fs.existsSync(path.join(local, 'task.md'))) fail(`missing local/task.md: ${taskDir}`);
    const expected = walkFiles(local).filter((f) => path.basename(f) !== 'contents.sha256')
      .map((f) => `${shaFile(f)}  ${path.relative(local, f).split(path.sep).join('/')}`);
    const actual = fs.readFileSync(path.join(local, 'contents.sha256'), 'utf8').trimEnd().split('\n').filter(Boolean);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) fail(`contents.sha256 mismatch: ${local}`);
    for (const entry of fs.readdirSync(taskDir, { withFileTypes: true })) {
      if (entry.name !== 'local') fail(`unexpected task root entry: ${path.join(taskDir, entry.name)}`);
    }
  }
}
function taskFields(taskDir) {
  const text = fs.readFileSync(path.join(taskDir, 'local', 'task.md'), 'utf8');
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? '';
  const field = (name) => frontmatter.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'm'))?.[1]?.replace(/^['"]|['"]$/g, '').trim() || '';
  const title = text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/m, '').match(/^# (.+)$/m)?.[1]?.replace(/^任务：|^Task:\s*/, '').replace(/\|/g, '\\|').trim() || path.basename(taskDir);
  const parts = path.relative(archive, taskDir).split(path.sep);
  return { year: parts[0], month: parts[1], day: parts[2], taskId: path.basename(taskDir), title, type: field('type') || 'unknown', completed: field('completed_at') || field('updated_at') || `${parts[0]}-${parts[1]}-${parts[2]}`, relative: `${parts.slice(0, 4).join('/')}/` };
}
function rebuildManifests(tasks) {
  if (!fs.existsSync(archive)) fs.mkdirSync(archive, { recursive: true });
  const entries = tasks.map(taskFields);
  for (const entry of fs.readdirSync(archive, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}$/.test(entry.name)) continue;
    const yearDir = path.join(archive, entry.name);
    fs.rmSync(path.join(yearDir, 'manifest.md'), { force: true });
    for (const month of fs.readdirSync(yearDir, { withFileTypes: true })) {
      if (month.isDirectory() && /^\d{2}$/.test(month.name)) fs.rmSync(path.join(yearDir, month.name, 'manifest.md'), { force: true });
    }
  }
  fs.rmSync(path.join(archive, 'manifest.md'), { force: true });
  const generated = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const header = ['# Archive Manifest', '', '> Auto-generated by archive-tasks. Do not edit manually.', `> Last updated: ${generated}`, ''];
  const years = [...new Set(entries.map((entry) => entry.year))].sort().reverse();
  for (const year of years) {
    const yearEntries = entries.filter((entry) => entry.year === year);
    const months = [...new Set(yearEntries.map((entry) => entry.month))].sort().reverse();
    for (const month of months) {
      const monthEntries = yearEntries.filter((entry) => entry.month === month).sort((a, b) => b.completed.localeCompare(a.completed) || b.taskId.localeCompare(a.taskId));
      const lines = [...header, '| Task ID | Title | Type | Completed | Path |', '| --- | --- | --- | --- | --- |', ...monthEntries.slice(0, 1000).map((entry) => `| ${entry.taskId} | ${entry.title} | ${entry.type} | ${entry.completed} | ${entry.relative} |`)];
      if (monthEntries.length > 1000) lines.push('', `> Showing 1000 of ${monthEntries.length} entries.`);
      const monthPath = path.join(archive, year, month, 'manifest.md');
      fs.mkdirSync(path.dirname(monthPath), { recursive: true });
      fs.writeFileSync(monthPath, `${lines.join('\n')}\n`);
    }
    const yearLines = [...header, '| Month | Tasks | Manifest |', '| --- | --- | --- |', ...months.map((month) => `| ${month} | ${yearEntries.filter((entry) => entry.month === month).length} | [${month}/manifest.md](${month}/manifest.md) |`)];
    fs.writeFileSync(path.join(archive, year, 'manifest.md'), `${yearLines.join('\n')}\n`);
  }
  const rootLines = [...header, '| Year | Tasks | Manifest |', '| --- | --- | --- |', ...years.map((year) => `| ${year} | ${entries.filter((entry) => entry.year === year).length} | [${year}/manifest.md](${year}/manifest.md) |`)];
  fs.writeFileSync(path.join(archive, 'manifest.md'), `${rootLines.join('\n')}\n`);
}
function migrationMarker(backupPath, backupSha) {
  const data = { schema_version: 1, state: 'migrating', backup: path.relative(workspace, backupPath).split(path.sep).join('/'), backup_sha256: backupSha };
  fs.writeFileSync(marker, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  const fd = fs.openSync(marker, 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
}
function migrate() {
  assertNoMarker();
  const tasks = listTasks();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const backupDir = path.join(workspace, 'archive-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.accessSync(backupDir, fs.constants.W_OK);
  const backup = path.join(backupDir, `archive-before-l0-${stamp}.tar`);
  if (fs.existsSync(backup)) fail(`backup already exists: ${backup}`);
  if (fs.existsSync(archive)) {
    const bytes = Number(run('du', ['-sk', archive]).split(/\s+/)[0]) * 1024;
    const available = Number(run('df', ['-Pk', backupDir]).trim().split(/\n/).at(-1)?.split(/\s+/).at(-3)) * 1024;
    if (!Number.isFinite(bytes) || !Number.isFinite(available) || available < bytes) fail(`insufficient backup space: need at least ${bytes} bytes, available ${available}`);
  }
  if (fs.existsSync(archive)) run('tar', ['-cf', backup, '-C', workspace, 'archive']);
  else run('tar', ['-cf', backup, '-C', workspace, '--files-from', '/dev/null']);
  run('tar', ['-tf', backup]);
  const backupSha = shaFile(backup);
  fs.writeFileSync(`${backup}.sha256`, `${backupSha}  ${path.basename(backup)}\n`, { flag: 'wx' });
  const verifyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-backup-verify-'));
  try {
    run('tar', ['-xf', backup, '-C', verifyRoot]);
    if (fs.existsSync(archive) !== fs.existsSync(path.join(verifyRoot, 'archive')) || (fs.existsSync(archive) && !sameSnapshot(archive, path.join(verifyRoot, 'archive')))) fail('backup tree does not match source archive');
  } finally { fs.rmSync(verifyRoot, { recursive: true, force: true }); }
  migrationMarker(backup, backupSha);
  if (process.env.NODE_ENV === 'test' && process.env.ARCHIVE_MIGRATION_TEST_PAUSE === '1') {
    process.stdout.write('marker-ready\n');
    setInterval(() => {}, 1000);
  }
  for (const taskDir of tasks) {
    const sourceEntries = fs.readdirSync(taskDir, { withFileTypes: true });
    const localTmp = path.join(taskDir, 'local.tmp');
    if (fs.existsSync(localTmp)) fail(`staging directory exists: ${localTmp}`);
    fs.mkdirSync(localTmp);
    for (const entry of sourceEntries) {
      if (entry.isFile()) fs.copyFileSync(path.join(taskDir, entry.name), path.join(localTmp, entry.name), fs.constants.COPYFILE_EXCL);
      else if (entry.isDirectory()) fs.cpSync(path.join(taskDir, entry.name), path.join(localTmp, entry.name), { recursive: true, errorOnExist: true });
    }
    writeContentsHash(localTmp);
    fs.renameSync(localTmp, path.join(taskDir, 'local'));
    for (const entry of fs.readdirSync(taskDir, { withFileTypes: true })) if (entry.name !== 'local') fs.rmSync(path.join(taskDir, entry.name), { recursive: true });
  }
  validateFinal(tasks);
  rebuildManifests(tasks);
  fs.rmSync(marker);
  process.stdout.write(`Migrated ${tasks.length} task(s); backup ${path.relative(repoRoot, backup)} SHA-256 ${backupSha}\n`);
}
function restore(backupArg) {
  if (!backupArg) fail('Usage: migrate-archive.mjs --restore <backup.tar>');
  const backup = path.resolve(backupArg);
  const state = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const expectedBackup = path.resolve(workspace, state.backup);
  const sidecar = fs.readFileSync(`${backup}.sha256`, 'utf8').trim().split(/\s+/)[0];
  if (state.schema_version !== 1 || state.state !== 'migrating' || expectedBackup !== backup || state.backup_sha256 !== shaFile(backup) || sidecar !== state.backup_sha256) fail('backup does not match migration marker or has an invalid digest');
  const verifyListing = run('tar', ['-tf', backup]);
  if (verifyListing.split('\n').filter(Boolean).some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))) fail('unsafe path in backup tar');
  const staging = path.join(workspace, `.archive-restore-${process.pid}`);
  fs.mkdirSync(staging, { recursive: false });
  run('tar', ['-xf', backup, '-C', staging]);
  const restored = path.join(staging, 'archive');
  const current = `${archive}.partial-${Date.now()}`;
  if (fs.existsSync(archive)) fs.renameSync(archive, current);
  if (fs.existsSync(restored)) fs.renameSync(restored, archive);
  const check = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-restore-check-'));
  try {
    run('tar', ['-xf', backup, '-C', check]);
    if (fs.existsSync(archive) !== fs.existsSync(path.join(check, 'archive')) || (fs.existsSync(archive) && !sameSnapshot(archive, path.join(check, 'archive')))) fail('restored archive does not match backup');
  } finally { fs.rmSync(check, { recursive: true, force: true }); fs.rmSync(staging, { recursive: true, force: true }); }
  fs.rmSync(marker);
  process.stdout.write(`Restored archive from ${backup}; preserved partial tree at ${current}\n`);
}

let release;
try {
  release = acquireLock();
  if (process.argv[2] === '--restore') restore(process.argv[3]);
  else if (process.argv.length === 2) migrate();
  else fail('Usage: migrate-archive.mjs [--restore <backup.tar>]');
} catch (error) {
  console.error(`archive migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally { release?.(); }
