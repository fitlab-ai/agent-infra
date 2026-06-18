import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveTaskRef } from '../resolve-ref.ts';
import { enumerateArtifacts, type Artifact } from '../artifacts.ts';
import { parseTaskFrontmatter, extractTitle, type Frontmatter } from '../frontmatter.ts';
import { loadShortIdByTaskId } from '../short-id.ts';

const USAGE = `Usage: ai task status <N | #N | TASK-id>

Prints an aggregated "health check" view for a task: header, metadata, an
artifacts summary, git branch state, and best-effort GitHub issue/PR status.
  <ref>   Bare numeric / '#N' short id, or a full TASK-YYYYMMDD-HHMMSS id.

Git and Platform rows are best-effort: a failed git/gh call degrades that row to
'-' without failing the command.
`;

const DASH = '-';

// Subprocess boundary: the single place this command shells out. Injectable so
// the collectors below can be unit-tested without spawning git/gh. Returns the
// command's stdout; throws (like execFileSync) on a non-zero exit or spawn error.
type Runner = (file: string, args: string[]) => string;

function makeRunner(cwd: string): Runner {
  return (file, args) =>
    execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// Run `run` and swallow any failure into null, so a single failing git/gh call
// degrades only its own field instead of aborting the whole view.
function tryRun(run: Runner, file: string, args: string[]): string | null {
  try {
    return run(file, args);
  } catch {
    return null;
  }
}

// Frontmatter keys shown in the Metadata section, in a fixed display order.
const METADATA_KEYS = [
  'type',
  'status',
  'current_step',
  'priority',
  'effort',
  'branch',
  'assigned_to',
  'created_at',
  'updated_at',
  'issue_number',
  'pr_status'
] as const;

function collectMetadata(fm: Frontmatter): [string, string][] {
  return METADATA_KEYS.map((key) => [key, fm[key] ? fm[key]! : DASH]);
}

// Workflow stages in timeline order; artifacts are bucketed by filename prefix.
// `review-*` prefixes are matched before their bare counterparts so that, e.g.,
// `review-analysis.md` is never swallowed by the `analysis` bucket.
const STAGE_ORDER = [
  'analysis',
  'review-analysis',
  'plan',
  'review-plan',
  'code',
  'review-code',
  'task',
  'other'
] as const;

function stageOf(name: string): string {
  const stem = name.replace(/\.md$/, '');
  if (stem === 'task') return 'task';
  if (stem.startsWith('review-analysis')) return 'review-analysis';
  if (stem.startsWith('review-plan')) return 'review-plan';
  if (stem.startsWith('review-code')) return 'review-code';
  if (stem.startsWith('analysis')) return 'analysis';
  if (stem.startsWith('plan')) return 'plan';
  if (stem.startsWith('code')) return 'code';
  return 'other';
}

// Group artifacts by workflow stage, preserving the input order (mtime ascending
// from enumerateArtifacts) within each stage and dropping empty stages.
function groupArtifacts(artifacts: Artifact[]): { stage: string; files: string[] }[] {
  const byStage = new Map<string, string[]>();
  for (const artifact of artifacts) {
    const stage = stageOf(artifact.name);
    const bucket = byStage.get(stage);
    if (bucket) bucket.push(artifact.name);
    else byStage.set(stage, [artifact.name]);
  }
  const groups: { stage: string; files: string[] }[] = [];
  for (const stage of STAGE_ORDER) {
    const files = byStage.get(stage);
    if (files && files.length > 0) groups.push({ stage, files });
  }
  return groups;
}

type GitInfo = {
  current: string;
  frontmatter: string;
  match: string;
  exists: string;
  uncommitted: string;
  aheadBehind: string;
};

// `frontmatterBranch` is the task.md `branch` field (caller passes '' when absent).
// It is read straight from frontmatter and never depends on a subprocess, so it
// keeps its value even when every git call fails. All other fields degrade to '-'
// on failure of their own command.
function collectGit(frontmatterBranch: string, run: Runner): GitInfo {
  const frontmatter = frontmatterBranch ? frontmatterBranch : DASH;

  let current = DASH;
  const cur = tryRun(run, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (cur !== null && cur.trim()) current = cur.trim();

  let match = DASH;
  if (current !== DASH && frontmatter !== DASH) {
    match = current === frontmatter ? 'yes' : 'no';
  }

  let exists = DASH;
  if (frontmatter !== DASH) {
    const verified = tryRun(run, 'git', ['rev-parse', '--verify', '--quiet', `refs/heads/${frontmatter}`]);
    exists = verified === null ? 'no' : 'yes';
  }

  let uncommitted = DASH;
  const porcelain = tryRun(run, 'git', ['status', '--porcelain']);
  if (porcelain !== null) {
    const changed = porcelain.split('\n').filter((line) => line.trim() !== '');
    uncommitted = changed.length === 0 ? 'clean' : `${changed.length} file(s)`;
  }

  let aheadBehind = DASH;
  if (frontmatter !== DASH) {
    const counts = tryRun(run, 'git', [
      'rev-list',
      '--left-right',
      '--count',
      `${frontmatter}...${frontmatter}@{upstream}`
    ]);
    if (counts !== null) {
      const parts = counts.trim().split(/\s+/);
      if (parts.length === 2) aheadBehind = `${parts[0]} ahead / ${parts[1]} behind`;
    }
  }

  return { current, frontmatter, match, exists, uncommitted, aheadBehind };
}

type PlatformInfo = { issue: string; pr: string };

function collectPlatform(fm: Frontmatter, run: Runner): PlatformInfo {
  let issue = DASH;
  if (fm.issue_number && /^\d+$/.test(fm.issue_number)) {
    const out = tryRun(run, 'gh', ['issue', 'view', fm.issue_number, '--json', 'state,labels']);
    if (out !== null) {
      try {
        const data = JSON.parse(out);
        const labels = Array.isArray(data.labels)
          ? data.labels.map((label: { name: string }) => label.name).join(', ')
          : '';
        issue = labels ? `${data.state} [${labels}]` : `${data.state}`;
      } catch {
        issue = DASH;
      }
    }
  }

  let pr = DASH;
  if (fm.pr_status === 'created' && fm.pr_number && /^\d+$/.test(fm.pr_number)) {
    const out = tryRun(run, 'gh', ['pr', 'view', fm.pr_number, '--json', 'state,statusCheckRollup']);
    if (out !== null) {
      try {
        const data = JSON.parse(out);
        const rollup = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];
        const passed = rollup.filter(
          (check: { conclusion?: string; state?: string }) =>
            check.conclusion === 'SUCCESS' || check.state === 'SUCCESS'
        ).length;
        pr = rollup.length > 0 ? `${data.state}, checks: ${passed}/${rollup.length}` : `${data.state}`;
      } catch {
        pr = DASH;
      }
    }
  }

  return { issue, pr };
}

type StatusModel = {
  taskId: string;
  shortId: string;
  title: string;
  issueNumber: string;
  metadata: [string, string][];
  artifacts: { count: number; groups: { stage: string; files: string[] }[] };
  git: GitInfo;
  platform: PlatformInfo;
};

// Indent each label/value pair by two spaces and pad labels to a common width so
// every section reads as an aligned "key   value" block.
function renderPairs(rows: [string, string][]): string[] {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`.trimEnd());
}

function renderStatus(model: StatusModel): string[] {
  const lines: string[] = [];

  lines.push(`Task ${model.taskId}  (${model.shortId})`);
  if (model.title) lines.push(model.title);

  lines.push('', 'Metadata', ...renderPairs(model.metadata));

  lines.push('', `Artifacts (${model.artifacts.count})`);
  if (model.artifacts.groups.length === 0) {
    lines.push('  (none)');
  } else {
    lines.push(...renderPairs(model.artifacts.groups.map((group) => [group.stage, group.files.join(', ')])));
  }

  lines.push(
    '',
    'Git',
    ...renderPairs([
      ['current', model.git.current],
      ['frontmatter', model.git.frontmatter],
      ['match', model.git.match],
      ['exists', model.git.exists],
      ['uncommitted', model.git.uncommitted],
      ['ahead/behind', model.git.aheadBehind]
    ])
  );

  const issueLabel = model.issueNumber ? `issue #${model.issueNumber}` : 'issue';
  lines.push(
    '',
    'Platform',
    ...renderPairs([
      [issueLabel, model.platform.issue],
      ['pr', model.platform.pr]
    ])
  );

  return lines;
}

function status(args: string[] = []): void {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    if (args.length === 0) process.exitCode = 1;
    return;
  }

  const resolved = resolveTaskRef(args[0]!);
  if (!resolved.ok) {
    process.stderr.write(`ai task status: ${resolved.message}\n`);
    process.exitCode = 1;
    return;
  }

  const content = fs.readFileSync(resolved.taskMdPath, 'utf8');
  const fm = parseTaskFrontmatter(content);
  const run = makeRunner(resolved.repoRoot);
  const artifacts = enumerateArtifacts(resolved.taskDir);

  const model: StatusModel = {
    taskId: resolved.taskId,
    shortId: loadShortIdByTaskId(resolved.repoRoot).get(resolved.taskId) ?? DASH,
    title: extractTitle(content),
    issueNumber: fm.issue_number && /^\d+$/.test(fm.issue_number) ? fm.issue_number : '',
    metadata: collectMetadata(fm),
    artifacts: { count: artifacts.length, groups: groupArtifacts(artifacts) },
    git: collectGit(fm.branch ?? '', run),
    platform: collectPlatform(fm, run)
  };

  for (const line of renderStatus(model)) {
    process.stdout.write(`${line}\n`);
  }
}

export {
  status,
  makeRunner,
  collectMetadata,
  groupArtifacts,
  collectGit,
  collectPlatform,
  renderStatus,
  METADATA_KEYS
};
export type { Runner, GitInfo, PlatformInfo, StatusModel };
