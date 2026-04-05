import fs from 'node:fs';
import path from 'node:path';
import { info, ok } from './log.js';

const TASK_ID_RE = /^TASK-\d{8}-\d{6}$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const TITLE_RE = /^# (.+)$/m;
const DATE_FROM_PATH_RE = /(?:^|[/\\])(\d{4})[/\\](\d{2})[/\\](\d{2})(?:[/\\]|$)/;

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

  const archiveDir = path.join(process.cwd(), '.agents', 'workspace', 'archive');
  const sourceTasks = scanSourceTasks(resolvedSource);
  const merged = [];
  const skipped = [];

  fs.mkdirSync(archiveDir, { recursive: true });

  for (const task of sourceTasks) {
    const existingTaskDir = taskExistsInArchive(archiveDir, task.taskId);
    if (existingTaskDir) {
      skipped.push({
        taskId: task.taskId,
        relativePath: path.relative(archiveDir, existingTaskDir).split(path.sep).join('/') + '/'
      });
      continue;
    }

    const destinationDir = path.join(archiveDir, task.relativePath);
    fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
    fs.cpSync(task.taskDir, destinationDir, { recursive: true });
    merged.push({
      taskId: task.taskId,
      relativePath: task.relativePath
    });
  }

  rebuildManifests(archiveDir);

  if (sourceTasks.length === 0) {
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
}

export {
  cmdMerge,
  extractField,
  extractTitle,
  rebuildManifests,
  scanSourceTasks,
  taskExistsInArchive
};
