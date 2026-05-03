import fs from 'node:fs';
import path from 'node:path';
import { info, ok } from './log.js';

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const TITLE_RE = /^# (.+)$/m;
const DATE_FROM_PATH_RE = /(?:^|[/\\])(\d{4})[/\\](\d{2})[/\\](\d{2})(?:[/\\]|$)/;
const MUTABLE_SECTIONS = ['active', 'blocked', 'completed'];
const ALL_SECTIONS = [...MUTABLE_SECTIONS, 'archive'];
const SECTION_LABELS = {
  active: 'Active',
  blocked: 'Blocked',
  completed: 'Completed',
  archive: 'Archive'
};
const DIVIDER = '═'.repeat(55);

function extractField(content, fieldName) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return null;
  }

  const lines = match[1].split(/\r?\n/);
  const prefix = `${fieldName}:`;

  for (const line of lines) {
    if (!line.startsWith(prefix)) {
      continue;
    }

    const value = line.slice(prefix.length).trim().replace(/^['"]|['"]$/g, '');
    return value || null;
  }

  return null;
}

function extractTitle(content) {
  const withoutFrontmatter = content.replace(FRONTMATTER_RE, '');
  const match = withoutFrontmatter.match(TITLE_RE);
  if (!match) {
    return null;
  }

  return match[1]
    .trim()
    .replace(/^任务：/, '')
    .replace(/^Task:\s*/, '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|') || null;
}

function normalizeTaskRecord(taskDir, taskFile, dateParts) {
  const taskId = path.basename(taskDir);
  const content = fs.readFileSync(taskFile, 'utf8');
  const completedAt = extractField(content, 'completed_at');
  const updatedAt = extractField(content, 'updated_at');
  const taskDate = completedAt || updatedAt || `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const title = extractTitle(content) || taskId;
  const type = extractField(content, 'type') || 'unknown';

  return {
    taskId,
    taskDir,
    relativePath: `${dateParts.year}/${dateParts.month}/${dateParts.day}/${taskId}/`,
    year: dateParts.year,
    month: dateParts.month,
    day: dateParts.day,
    title,
    type,
    completedAt: taskDate
  };
}

function fallbackDateParts(taskDir, content) {
  const pathMatch = taskDir.match(DATE_FROM_PATH_RE);
  if (pathMatch) {
    return {
      year: pathMatch[1],
      month: pathMatch[2],
      day: pathMatch[3]
    };
  }

  const completedAt = extractField(content, 'completed_at');
  const updatedAt = extractField(content, 'updated_at');
  const source = completedAt || updatedAt;
  const dateMatch = source?.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (dateMatch) {
    return {
      year: dateMatch[1],
      month: dateMatch[2],
      day: dateMatch[3]
    };
  }

  return null;
}

function scanSourceTasks(sourceDir) {
  const tasks = [];
  const years = fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir, { withFileTypes: true }) : [];

  for (const yearEntry of years) {
    if (!yearEntry.isDirectory() || !/^\d{4}$/.test(yearEntry.name)) {
      continue;
    }

    const yearDir = path.join(sourceDir, yearEntry.name);
    for (const monthEntry of fs.readdirSync(yearDir, { withFileTypes: true })) {
      if (!monthEntry.isDirectory() || !/^\d{2}$/.test(monthEntry.name)) {
        continue;
      }

      const monthDir = path.join(yearDir, monthEntry.name);
      for (const dayEntry of fs.readdirSync(monthDir, { withFileTypes: true })) {
        if (!dayEntry.isDirectory() || !/^\d{2}$/.test(dayEntry.name)) {
          continue;
        }

        const dayDir = path.join(monthDir, dayEntry.name);
        for (const taskEntry of fs.readdirSync(dayDir, { withFileTypes: true })) {
          if (!taskEntry.isDirectory() || !TASK_ID_RE.test(taskEntry.name)) {
            continue;
          }

          const taskDir = path.join(dayDir, taskEntry.name);
          const taskFile = path.join(taskDir, 'task.md');
          if (!fs.existsSync(taskFile)) {
            continue;
          }

          tasks.push(normalizeTaskRecord(taskDir, taskFile, {
            year: yearEntry.name,
            month: monthEntry.name,
            day: dayEntry.name
          }));
        }
      }
    }
  }

  if (tasks.length > 0) {
    return tasks;
  }

  // Fall back to a deeper scan if the source layout is unusual but still contains archived tasks.
  const stack = [sourceDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir || !fs.existsSync(currentDir)) {
      continue;
    }

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (!entry.isDirectory()) {
        continue;
      }

      if (TASK_ID_RE.test(entry.name)) {
        const taskFile = path.join(entryPath, 'task.md');
        if (!fs.existsSync(taskFile)) {
          continue;
        }

        const content = fs.readFileSync(taskFile, 'utf8');
        const dateParts = fallbackDateParts(entryPath, content);
        if (!dateParts) {
          continue;
        }

        tasks.push(normalizeTaskRecord(entryPath, taskFile, dateParts));
        continue;
      }

      stack.push(entryPath);
    }
  }

  return tasks.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function findTaskDirById(rootDir, taskId) {
  if (!fs.existsSync(rootDir)) {
    return null;
  }

  for (const yearEntry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!yearEntry.isDirectory() || !/^\d{4}$/.test(yearEntry.name)) {
      continue;
    }

    const yearDir = path.join(rootDir, yearEntry.name);
    for (const monthEntry of fs.readdirSync(yearDir, { withFileTypes: true })) {
      if (!monthEntry.isDirectory() || !/^\d{2}$/.test(monthEntry.name)) {
        continue;
      }

      const monthDir = path.join(yearDir, monthEntry.name);
      for (const dayEntry of fs.readdirSync(monthDir, { withFileTypes: true })) {
        if (!dayEntry.isDirectory() || !/^\d{2}$/.test(dayEntry.name)) {
          continue;
        }

        const candidate = path.join(monthDir, dayEntry.name, taskId);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      }
    }
  }

  return null;
}

function taskExistsInArchive(archiveDir, taskId) {
  return findTaskDirById(archiveDir, taskId);
}

function formatManifestHeader(generatedAt) {
  return [
    '# Archive Manifest',
    '',
    '> Auto-generated by archive-tasks. Do not edit manually.',
    `> Last updated: ${generatedAt}`,
    ''
  ];
}

function collectArchiveEntries(archiveDir) {
  const entries = [];
  if (!fs.existsSync(archiveDir)) {
    return entries;
  }

  for (const yearEntry of fs.readdirSync(archiveDir, { withFileTypes: true })) {
    if (!yearEntry.isDirectory() || !/^\d{4}$/.test(yearEntry.name)) {
      continue;
    }

    const yearDir = path.join(archiveDir, yearEntry.name);
    for (const monthEntry of fs.readdirSync(yearDir, { withFileTypes: true })) {
      if (!monthEntry.isDirectory() || !/^\d{2}$/.test(monthEntry.name)) {
        continue;
      }

      const monthDir = path.join(yearDir, monthEntry.name);
      for (const dayEntry of fs.readdirSync(monthDir, { withFileTypes: true })) {
        if (!dayEntry.isDirectory() || !/^\d{2}$/.test(dayEntry.name)) {
          continue;
        }

        const dayDir = path.join(monthDir, dayEntry.name);
        for (const taskEntry of fs.readdirSync(dayDir, { withFileTypes: true })) {
          if (!taskEntry.isDirectory() || !TASK_ID_RE.test(taskEntry.name)) {
            continue;
          }

          const taskDir = path.join(dayDir, taskEntry.name);
          const taskFile = path.join(taskDir, 'task.md');
          const relativePath = `${yearEntry.name}/${monthEntry.name}/${dayEntry.name}/${taskEntry.name}/`;
          let title = taskEntry.name;
          let type = 'unknown';
          let completedAt = `${yearEntry.name}-${monthEntry.name}-${dayEntry.name}`;

          if (fs.existsSync(taskFile)) {
            const content = fs.readFileSync(taskFile, 'utf8');
            title = extractTitle(content) || title;
            type = extractField(content, 'type') || type;
            completedAt = extractField(content, 'completed_at') || completedAt;
          }

          entries.push({
            year: yearEntry.name,
            month: monthEntry.name,
            completedAt,
            taskId: taskEntry.name,
            title,
            type,
            relativePath
          });
        }
      }
    }
  }

  return entries;
}

function rebuildManifests(archiveDir) {
  fs.mkdirSync(archiveDir, { recursive: true });
  const entries = collectArchiveEntries(archiveDir);
  const generatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

  removeManifestFiles(archiveDir);

  const monthGroups = new Map();
  const yearCounts = new Map();
  const monthCounts = new Map();

  for (const entry of entries) {
    const monthKey = `${entry.year}\t${entry.month}`;
    if (!monthGroups.has(monthKey)) {
      monthGroups.set(monthKey, []);
    }
    monthGroups.get(monthKey).push(entry);
    yearCounts.set(entry.year, (yearCounts.get(entry.year) || 0) + 1);
    monthCounts.set(monthKey, (monthCounts.get(monthKey) || 0) + 1);
  }

  for (const [monthKey, monthEntries] of [...monthGroups.entries()].sort()) {
    const [year, month] = monthKey.split('\t');
    const monthManifestPath = path.join(archiveDir, year, month, 'manifest.md');
    fs.mkdirSync(path.dirname(monthManifestPath), { recursive: true });

    const sortedEntries = [...monthEntries].sort((left, right) => {
      const completedCompare = right.completedAt.localeCompare(left.completedAt);
      if (completedCompare !== 0) {
        return completedCompare;
      }
      return right.taskId.localeCompare(left.taskId);
    });

    const lines = [
      ...formatManifestHeader(generatedAt),
      '| Task ID | Title | Type | Completed | Path |',
      '| --- | --- | --- | --- | --- |'
    ];

    for (const entry of sortedEntries.slice(0, 1000)) {
      lines.push(
        `| ${entry.taskId} | ${entry.title} | ${entry.type} | ${entry.completedAt} | ${entry.relativePath} |`
      );
    }

    if (sortedEntries.length > 1000) {
      lines.push('', `> Showing 1000 of ${sortedEntries.length} entries.`);
    }

    fs.writeFileSync(monthManifestPath, `${lines.join('\n')}\n`, 'utf8');
  }

  for (const year of [...yearCounts.keys()].sort().reverse()) {
    const yearManifestPath = path.join(archiveDir, year, 'manifest.md');
    fs.mkdirSync(path.dirname(yearManifestPath), { recursive: true });

    const lines = [
      ...formatManifestHeader(generatedAt),
      '| Month | Tasks | Manifest |',
      '| --- | --- | --- |'
    ];

    for (const month of [...monthGroups.keys()]
      .filter((key) => key.startsWith(`${year}\t`))
      .map((key) => key.split('\t')[1])
      .sort()
      .reverse()) {
      lines.push(
        `| ${month} | ${monthCounts.get(`${year}\t${month}`)} | [${month}/manifest.md](${month}/manifest.md) |`
      );
    }

    fs.writeFileSync(yearManifestPath, `${lines.join('\n')}\n`, 'utf8');
  }

  const rootLines = [
    ...formatManifestHeader(generatedAt),
    '| Year | Tasks | Manifest |',
    '| --- | --- | --- |'
  ];

  for (const year of [...yearCounts.keys()].sort().reverse()) {
    rootLines.push(
      `| ${year} | ${yearCounts.get(year)} | [${year}/manifest.md](${year}/manifest.md) |`
    );
  }

  fs.writeFileSync(path.join(archiveDir, 'manifest.md'), `${rootLines.join('\n')}\n`, 'utf8');
}

function removeManifestFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('TASK-')) {
        continue;
      }
      removeManifestFiles(entryPath);
      continue;
    }

    if (entry.isFile() && entry.name === 'manifest.md') {
      fs.rmSync(entryPath, { force: true });
    }
  }
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const offsetRemainderMinutes = absoluteOffsetMinutes % 60;

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + ' ' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join(':') + `${sign}${pad(offsetHours)}:${pad(offsetRemainderMinutes)}`;
}

function formatBackupTimestamp(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('') + `-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
}

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function getLatestFileMtime(taskDir) {
  let latestMs = null;
  const stack = [taskDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir || !fs.existsSync(currentDir)) {
      continue;
    }

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      const { mtimeMs } = fs.statSync(entryPath);
      latestMs = latestMs === null ? mtimeMs : Math.max(latestMs, mtimeMs);
    }
  }

  return latestMs;
}

function getTaskTimestamp(taskDir) {
  const taskFile = path.join(taskDir, 'task.md');

  if (fs.existsSync(taskFile)) {
    const content = fs.readFileSync(taskFile, 'utf8');
    const updatedAt = extractField(content, 'updated_at');
    if (updatedAt) {
      return { value: updatedAt, source: 'frontmatter' };
    }

    const taskFileStat = fs.statSync(taskFile);
    return {
      value: formatTimestamp(taskFileStat.mtime),
      source: 'task-mtime'
    };
  }

  const latestMs = getLatestFileMtime(taskDir);
  if (latestMs !== null) {
    return {
      value: formatTimestamp(new Date(latestMs)),
      source: 'dir-mtime'
    };
  }

  const dirStat = fs.statSync(taskDir);
  return {
    value: formatTimestamp(dirStat.mtime),
    source: 'dir-mtime'
  };
}

function compareTimestamps(left, right) {
  const normalizeTimestamp = (timestamp) => (timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T'));
  const leftMs = Date.parse(normalizeTimestamp(left.value));
  const rightMs = Date.parse(normalizeTimestamp(right.value));

  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) {
    return left.value.localeCompare(right.value);
  }

  return leftMs - rightMs;
}

function scanWorkspaceSection(rootDir, sectionName) {
  const sectionDir = path.join(rootDir, sectionName);
  if (!fs.existsSync(sectionDir) || !fs.statSync(sectionDir).isDirectory()) {
    return [];
  }

  const records = [];
  for (const entry of fs.readdirSync(sectionDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !TASK_ID_RE.test(entry.name)) {
      continue;
    }

    const taskDir = path.join(sectionDir, entry.name);
    const taskFile = path.join(taskDir, 'task.md');
    if (!fs.existsSync(taskFile)) {
      continue;
    }

    records.push({
      taskId: entry.name,
      section: sectionName,
      taskDir,
      timestamp: getTaskTimestamp(taskDir)
    });
  }

  return records.sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function buildWorkspaceIndex(workspaceDir) {
  const index = new Map();

  for (const section of MUTABLE_SECTIONS) {
    for (const record of scanWorkspaceSection(workspaceDir, section)) {
      index.set(record.taskId, record);
    }
  }

  return index;
}

function backupTaskDir(backupRoot, section, taskDir, taskId) {
  const backupDir = path.join(backupRoot, section, taskId);
  fs.mkdirSync(path.dirname(backupDir), { recursive: true });
  fs.cpSync(taskDir, backupDir, { recursive: true });
  return backupDir;
}

function copyTaskToSection(sourceTask, workspaceDir) {
  const destinationDir = path.join(workspaceDir, sourceTask.section, sourceTask.taskId);
  fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
  fs.cpSync(sourceTask.taskDir, destinationDir, { recursive: true });
  return destinationDir;
}

function detectSourceMode(sourcePath) {
  for (const section of ALL_SECTIONS) {
    const sectionDir = path.join(sourcePath, section);
    if (fs.existsSync(sectionDir) && fs.statSync(sectionDir).isDirectory()) {
      return 'workspace';
    }
  }

  return 'legacy-archive';
}

function createReport(sourcePath, backupRoot) {
  return {
    sourcePath,
    backupRoot,
    sections: {
      active: { copied: [], updated: [], moved: [], skipped: [] },
      blocked: { copied: [], updated: [], moved: [], skipped: [] },
      completed: { copied: [], updated: [], moved: [], skipped: [] },
      archive: { copied: [], skipped: [] }
    },
    details: [],
    backupCount: 0
  };
}

function recordMutable(report, reportSection, action, entry) {
  report.sections[reportSection][action].push(entry);
  report.details.push(entry);
}

function recordArchive(report, action, entry) {
  report.sections.archive[action].push(entry);
  report.details.push(entry);
}

function mergeMutableSections({ sourceWorkspace, localWorkspace, backupRoot, report }) {
  const localIndex = buildWorkspaceIndex(localWorkspace);

  for (const sourceSection of MUTABLE_SECTIONS) {
    const sourceTasks = scanWorkspaceSection(sourceWorkspace, sourceSection);

    for (const sourceTask of sourceTasks) {
      const localMatch = localIndex.get(sourceTask.taskId) || null;

      if (!localMatch) {
        const destinationDir = copyTaskToSection(sourceTask, localWorkspace);
        localIndex.set(sourceTask.taskId, {
          taskId: sourceTask.taskId,
          section: sourceTask.section,
          taskDir: destinationDir,
          timestamp: getTaskTimestamp(destinationDir)
        });
        recordMutable(report, sourceTask.section, 'copied', {
          action: 'copied',
          symbol: '✓',
          taskId: sourceTask.taskId,
          section: sourceTask.section,
          detail: 'copied'
        });
        continue;
      }

      const comparison = compareTimestamps(sourceTask.timestamp, localMatch.timestamp);
      if (comparison > 0) {
        backupTaskDir(backupRoot, localMatch.section, localMatch.taskDir, localMatch.taskId);
        report.backupCount += 1;
        fs.rmSync(localMatch.taskDir, { recursive: true, force: true });

        const destinationDir = copyTaskToSection(sourceTask, localWorkspace);
        localIndex.set(sourceTask.taskId, {
          taskId: sourceTask.taskId,
          section: sourceTask.section,
          taskDir: destinationDir,
          timestamp: getTaskTimestamp(destinationDir)
        });

        if (localMatch.section === sourceTask.section) {
          recordMutable(report, sourceTask.section, 'updated', {
            action: 'updated',
            symbol: '↑',
            taskId: sourceTask.taskId,
            section: sourceTask.section,
            detail: `updated (source newer: ${sourceTask.timestamp.value} > ${localMatch.timestamp.value})`
          });
        } else {
          recordMutable(report, localMatch.section, 'moved', {
            action: 'moved',
            symbol: '⇄',
            taskId: sourceTask.taskId,
            fromSection: localMatch.section,
            toSection: sourceTask.section,
            detail: `moved (source newer: ${sourceTask.timestamp.value} > ${localMatch.timestamp.value})`
          });
        }

        continue;
      }

      if (comparison < 0) {
        recordMutable(report, localMatch.section, 'skipped', {
          action: 'skipped',
          symbol: '⊘',
          taskId: sourceTask.taskId,
          section: localMatch.section,
          detail: `skipped (local newer: ${localMatch.timestamp.value} > ${sourceTask.timestamp.value})`
        });
        continue;
      }

      recordMutable(report, localMatch.section, 'skipped', {
        action: 'skipped',
        symbol: '⊘',
        taskId: sourceTask.taskId,
        section: localMatch.section,
        detail: `skipped (same timestamp: ${sourceTask.timestamp.value})`
      });
    }
  }
}

function mergeArchiveSection(sourceArchive, localArchive, report) {
  const sourceTasks = scanSourceTasks(sourceArchive);

  for (const task of sourceTasks) {
    const existingTaskDir = taskExistsInArchive(localArchive, task.taskId);
    if (existingTaskDir) {
      recordArchive(report, 'skipped', {
        action: 'skipped',
        symbol: '⊘',
        taskId: task.taskId,
        section: 'archive',
        relativePath: `${toPosixPath(path.relative(localArchive, existingTaskDir))}/`,
        detail: `skipped (already exists at ${toPosixPath(path.relative(localArchive, existingTaskDir))}/)`
      });
      continue;
    }

    const destinationDir = path.join(localArchive, task.relativePath);
    fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
    fs.cpSync(task.taskDir, destinationDir, { recursive: true });
    recordArchive(report, 'copied', {
      action: 'copied',
      symbol: '✓',
      taskId: task.taskId,
      section: 'archive',
      relativePath: task.relativePath,
      detail: 'copied'
    });
  }

  return sourceTasks.length;
}

function printLegacyArchiveMessages(report, sourcePath) {
  const merged = report.sections.archive.copied;
  const skipped = report.sections.archive.skipped;

  if (merged.length === 0 && skipped.length === 0) {
    info(`No archived tasks found in ${sourcePath}`);
  }

  for (const task of merged) {
    ok(`Merged ${task.taskId} -> ${task.relativePath}`);
  }

  for (const task of skipped) {
    info(`Skipped ${task.taskId} (already exists at ${task.relativePath})`);
  }

  process.stdout.write('\n');
  info('Merge summary');
  info(`- Merged: ${merged.length}`);
  info(`- Skipped: ${skipped.length}`);
  process.stdout.write('\n');
}

function printSection(lines, name, counts) {
  const title = `${SECTION_LABELS[name].padEnd(9, ' ')} (.agents/workspace/${name}/):`;
  lines.push(title);

  const entries = [
    ['copied', '✓ Copied  '],
    ['updated', '↑ Updated '],
    ['moved', '⇄ Moved   '],
    ['skipped', '⊘ Skipped ']
  ].filter(([key]) => Array.isArray(counts[key]));

  const nonZeroEntries = entries.filter(([key]) => counts[key].length > 0);
  if (nonZeroEntries.length === 0) {
    lines.push('  (no changes)', '');
    return;
  }

  for (const [key, label] of nonZeroEntries) {
    lines.push(`  ${label}: ${counts[key].length}`);
  }

  lines.push('');
}

function printArchiveSection(lines, counts) {
  const title = `${SECTION_LABELS.archive.padEnd(9, ' ')} (.agents/workspace/archive/):`;
  lines.push(title);

  if (counts.copied.length === 0 && counts.skipped.length === 0) {
    lines.push('  (no changes)', '');
    return;
  }

  if (counts.copied.length > 0) {
    lines.push(`  ✓ Copied  : ${counts.copied.length}`);
  }
  if (counts.skipped.length > 0) {
    lines.push(`  ⊘ Skipped : ${counts.skipped.length}`);
  }
  lines.push('');
}

function renderDetail(entry) {
  if (entry.action === 'moved') {
    return `  ${entry.symbol} ${entry.taskId}  ${entry.fromSection}→${entry.toSection}  ${entry.detail}`;
  }

  const label = entry.section.padEnd(9, ' ');
  return `  ${entry.symbol} ${entry.taskId}  ${label} ${entry.detail}`;
}

function printReport(report) {
  const mutableTotals = MUTABLE_SECTIONS.reduce((acc, section) => {
    acc.copied += report.sections[section].copied.length;
    acc.updated += report.sections[section].updated.length;
    acc.moved += report.sections[section].moved.length;
    acc.skipped += report.sections[section].skipped.length;
    return acc;
  }, { copied: 0, updated: 0, moved: 0, skipped: 0 });

  const archiveTotals = {
    copied: report.sections.archive.copied.length,
    skipped: report.sections.archive.skipped.length
  };

  const lines = [
    'Merge summary',
    DIVIDER,
    `Source: ${report.sourcePath}`,
    `Backup: ${report.backupRoot}`,
    ''
  ];

  for (const section of MUTABLE_SECTIONS) {
    printSection(lines, section, report.sections[section]);
  }
  printArchiveSection(lines, report.sections.archive);

  lines.push(
    DIVIDER,
    `Totals: ${mutableTotals.copied + archiveTotals.copied} copied, ${mutableTotals.updated} updated, ${mutableTotals.moved} moved, ${mutableTotals.skipped + archiveTotals.skipped} skipped`,
    `Backup contains ${report.backupCount} task(s); review and remove when verified.`,
    '',
    'Detailed log:'
  );

  if (report.details.length === 0) {
    lines.push('  (none)');
  } else {
    for (const detail of report.details) {
      lines.push(renderDetail(detail));
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

async function cmdMerge(args) {
  const sourcePath = args[0];
  if (!sourcePath) {
    throw new Error('Usage: agent-infra merge <source-path>');
  }

  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Source path does not exist: ${sourcePath}`);
  }

  if (!fs.statSync(resolvedSource).isDirectory()) {
    throw new Error(`Source path is not a directory: ${sourcePath}`);
  }

  const workspaceDir = path.join(process.cwd(), '.agents', 'workspace');
  const archiveDir = path.join(workspaceDir, 'archive');
  const backupStamp = formatBackupTimestamp(new Date());
  const backupRootRelative = `.agents/workspace/.merge-backup/${backupStamp}/`;
  const backupRoot = path.join(workspaceDir, '.merge-backup', backupStamp);
  const report = createReport(resolvedSource, backupRootRelative);
  const mode = detectSourceMode(resolvedSource);

  for (const section of ALL_SECTIONS) {
    fs.mkdirSync(path.join(workspaceDir, section), { recursive: true });
  }

  if (mode === 'legacy-archive') {
    info('Detected legacy archive source; treating the input as archive-only for backward compatibility.');
    mergeArchiveSection(resolvedSource, archiveDir, report);
  } else {
    mergeMutableSections({
      sourceWorkspace: resolvedSource,
      localWorkspace: workspaceDir,
      backupRoot,
      report
    });

    const sourceArchive = path.join(resolvedSource, 'archive');
    if (fs.existsSync(sourceArchive) && fs.statSync(sourceArchive).isDirectory()) {
      mergeArchiveSection(sourceArchive, archiveDir, report);
    }
  }

  rebuildManifests(archiveDir);

  if (mode === 'legacy-archive') {
    printLegacyArchiveMessages(report, sourcePath);
  }

  printReport(report);
}

export {
  cmdMerge,
  compareTimestamps,
  detectSourceMode,
  extractField,
  extractTitle,
  formatBackupTimestamp,
  getTaskTimestamp,
  rebuildManifests,
  scanSourceTasks,
  scanWorkspaceSection,
  taskExistsInArchive
};
