import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commandForEngine } from '../../sandbox/shell.ts';
import { parseTaskScope } from '../command-options.ts';
import { resolveTaskContext, resolveTaskRef } from '../resolve-ref.ts';
import { enumerateArtifacts, type Artifact } from '../artifacts.ts';
import { parseTaskFrontmatter, extractTitle, type Frontmatter } from '../frontmatter.ts';
import { loadShortIdByTaskId } from '../short-id.ts';
import { getOpenWorkflowWarnings, formatWorkflowWarningSummary, type WorkflowWarning } from '../workflow-warnings.ts';
import { parseActivityLog, pairEntries } from '../activity-log.ts';
import { readRun, type OrchestrationRun } from '../orchestration.ts';
import type { DelegationReceipt } from '../delegation-receipts.ts';
import { statusCard, type DisplayMessage } from '../../server/display.ts';

const USAGE = `Usage: ai task status [--task <ref> | -t <ref>]

Prints an aggregated "health check" view for a task: header, metadata,
artifacts, workflow/runtime execution state, and git branch state.
  Omit the scope   Resolve the unique active task for the current branch.
  --task/-t <ref> Bare numeric short id, or a full TASK-YYYYMMDD-HHMMSS id.

Git rows are best-effort: a failed git call degrades that row to '-' without
failing the command.
`;

const DASH = '-';

// Subprocess boundary: the single place this command shells out. Injectable so
// the collectors below can be unit-tested without spawning git. Returns the
// command's stdout; throws (like execFileSync) on a non-zero exit or spawn error.
type Runner = (file: string, args: string[]) => string;

function makeRunner(cwd: string): Runner {
  return (file, args) =>
    execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// Run `run` and swallow any failure into null, so a single failing git call
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
  'updated_at'
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
  'validation-run',
  'task',
  'other'
] as const;

function stageOf(name: string): string {
  const stem = name.replace(/\.md$/, '');
  if (stem === 'task') return 'task';
  if (stem.startsWith('review-analysis')) return 'review-analysis';
  if (stem.startsWith('review-plan')) return 'review-plan';
  if (stem.startsWith('review-code')) return 'review-code';
  if (stem.startsWith('validation-run')) return 'validation-run';
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

type WorkflowInfo = {
  state: string;
  step: string;
  agent: string;
  startedAt: string;
  doneAt: string;
  stale: string;
};

const STALE_MS = 60 * 60 * 1000;

function parseActivityTime(value: string): number {
  const epoch = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(epoch) ? epoch : Number.NaN;
}

function collectWorkflow(content: string, now: Date = new Date()): WorkflowInfo {
  const parsed = parseActivityLog(content);
  if (!parsed.sectionFound || parsed.entries.length === 0) {
    return { state: 'unknown', step: DASH, agent: DASH, startedAt: DASH, doneAt: DASH, stale: DASH };
  }

  const rows = pairEntries(parsed.entries);
  const latest = rows.at(-1);
  if (!latest) {
    return { state: 'unknown', step: DASH, agent: DASH, startedAt: DASH, doneAt: DASH, stale: DASH };
  }

  const inProgress = latest.started !== '' && latest.done === '';
  const state = inProgress ? 'in-progress' : latest.done ? 'idle' : 'unknown';
  let stale = DASH;
  if (inProgress) {
    const started = parseActivityTime(latest.started);
    stale = Number.isFinite(started) ? (now.getTime() - started > STALE_MS ? 'yes' : 'no') : 'unknown';
  }

  return {
    state,
    step: latest.step || DASH,
    agent: latest.agent || DASH,
    startedAt: latest.started || DASH,
    doneAt: latest.done || DASH,
    stale
  };
}

type RuntimeInfo = {
  mode: string;
  status: string;
  run: string;
  tmux: string;
  startedAt: string;
  finishedAt: string;
  exitCode: string;
  log: string;
};

type PendingDelegationInfo = Readonly<Pick<
  DelegationReceipt,
  'id' | 'role' | 'stage' | 'round' | 'artifact' | 'client' | 'status'
>>;

type OrchestrationInfo = Readonly<{
  status: 'absent' | OrchestrationRun['status'];
  runId: string;
  nextStage: string;
  pause: Readonly<{ code: string; message: string; recoverable: boolean }> | null;
  pendingDelegation: PendingDelegationInfo | null;
}>;

type ManagedRunRecord = {
  run_id: string;
  engine: string;
  container: string;
  run_dir: string;
  status_file: string;
  log_file: string;
};

function latestRunRecord(taskDir: string): ManagedRunRecord | null {
  const runsDir = path.join(taskDir, 'runs');
  if (!fs.existsSync(runsDir)) return null;
  const candidates: { path: string; mtimeMs: number }[] = [];
  for (const entry of fs.readdirSync(runsDir)) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(runsDir, entry);
    const stat = fs.statSync(filePath);
    if (stat.isFile()) candidates.push({ path: filePath, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(candidate.path, 'utf8'));
      if (
        typeof data?.run_id === 'string' &&
        typeof data?.engine === 'string' &&
        typeof data?.container === 'string' &&
        typeof data?.run_dir === 'string'
      ) {
        return {
          run_id: data.run_id,
          engine: data.engine,
          container: data.container,
          run_dir: data.run_dir,
          status_file:
            typeof data.status_file === 'string' ? data.status_file : `${data.run_dir}/status`,
          log_file:
            typeof data.log_file === 'string' ? data.log_file : `${data.run_dir}/output.log`
        };
      }
    } catch {
      // Ignore malformed local records and try the next newest file.
    }
  }

  return null;
}

function readRuntimeFile(record: ManagedRunRecord, filePath: string, run: Runner): string | null {
  const command = commandForEngine(record.engine, 'docker', ['exec', record.container, 'cat', filePath]);
  const output = tryRun(run, command.cmd, command.args);
  return output === null ? null : output.trim();
}

function runtimeValue(record: ManagedRunRecord, name: string, run: Runner): string {
  const output = readRuntimeFile(record, `${record.run_dir}/${name}`, run);
  return output ? output : DASH;
}

function collectRuntime(taskDir: string, workflow: WorkflowInfo, run: Runner): RuntimeInfo {
  const record = latestRunRecord(taskDir);
  if (!record) {
    return workflow.state === 'in-progress'
      ? {
          mode: 'unmanaged',
          status: 'inferred-from-workflow',
          run: DASH,
          tmux: DASH,
          startedAt: DASH,
          finishedAt: DASH,
          exitCode: DASH,
          log: DASH
        }
      : {
          mode: 'none',
          status: DASH,
          run: DASH,
          tmux: DASH,
          startedAt: DASH,
          finishedAt: DASH,
          exitCode: DASH,
          log: DASH
        };
  }

  const status = readRuntimeFile(record, record.status_file, run)?.trim() || 'unknown';
  const session = runtimeValue(record, 'session', run);
  const window = runtimeValue(record, 'window', run);
  const pane = runtimeValue(record, 'pane', run);
  const tmux = session !== DASH && window !== DASH && pane !== DASH ? `${session}:${window}:${pane}` : DASH;

  return {
    mode: 'managed-tmux',
    status,
    run: record.run_id,
    tmux,
    startedAt: runtimeValue(record, 'started_at', run),
    finishedAt: runtimeValue(record, 'finished_at', run),
    exitCode: runtimeValue(record, 'exit_code', run),
    log: record.log_file
  };
}

function pendingDelegationInfo(receipt: DelegationReceipt | null): PendingDelegationInfo | null {
  if (!receipt) return null;
  return {
    id: receipt.id,
    role: receipt.role,
    stage: receipt.stage,
    round: receipt.round,
    artifact: receipt.artifact,
    client: receipt.client,
    status: receipt.status
  };
}

function collectOrchestration(taskDir: string): OrchestrationInfo {
  const run = readRun(taskDir);
  if (!run) {
    return {
      status: 'absent',
      runId: DASH,
      nextStage: DASH,
      pause: null,
      pendingDelegation: null
    };
  }
  return {
    status: run.status,
    runId: run.runId,
    nextStage: run.nextStage ?? DASH,
    pause: run.pause,
    pendingDelegation: pendingDelegationInfo(run.pendingDelegation)
  };
}

type StatusModel = {
  taskId: string;
  shortId: string;
  title: string;
  metadata: [string, string][];
  workflowWarnings: WorkflowWarning[];
  artifacts: { count: number; groups: { stage: string; files: string[] }[] };
  workflow: WorkflowInfo;
  runtime: RuntimeInfo;
  orchestration: OrchestrationInfo;
  git: GitInfo;
};

type BuildStatusModelInput = {
  taskId: string;
  taskDir: string;
  taskMdPath: string;
  repoRoot: string;
  shortId?: string;
  run?: Runner;
  now?: Date;
};

type BuildStatusModelOptions = {
  run?: Runner;
  now?: Date;
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

  if (model.workflowWarnings.length > 0) {
    lines.push(
      '',
      `Workflow Warnings (${model.workflowWarnings.length} open)`,
      ...formatWorkflowWarningSummary(model.workflowWarnings).map((line) => `  ${line}`)
    );
  }

  lines.push('', `Artifacts (${model.artifacts.count})`);
  if (model.artifacts.groups.length === 0) {
    lines.push('  (none)');
  } else {
    lines.push(...renderPairs(model.artifacts.groups.map((group) => [group.stage, group.files.join(', ')])));
  }

  lines.push(
    '',
    'Orchestration',
    ...renderPairs([
      ['status', model.orchestration.status],
      ['run_id', model.orchestration.runId],
      ['next_stage', model.orchestration.nextStage],
      ['pause_code', model.orchestration.pause?.code ?? DASH],
      ['pause_message', model.orchestration.pause?.message ?? DASH],
      ['recoverable', model.orchestration.pause ? String(model.orchestration.pause.recoverable) : DASH],
      ['pending_id', model.orchestration.pendingDelegation?.id ?? DASH],
      ['pending_role', model.orchestration.pendingDelegation?.role ?? DASH],
      ['pending_stage', model.orchestration.pendingDelegation?.stage ?? DASH],
      ['pending_round', model.orchestration.pendingDelegation ? String(model.orchestration.pendingDelegation.round) : DASH],
      ['pending_artifact', model.orchestration.pendingDelegation?.artifact ?? DASH],
      ['pending_client', model.orchestration.pendingDelegation?.client ?? DASH],
      ['pending_status', model.orchestration.pendingDelegation?.status ?? DASH]
    ])
  );

  lines.push(
    '',
    'Workflow',
    ...renderPairs([
      ['state', model.workflow.state],
      ['step', model.workflow.step],
      ['agent', model.workflow.agent],
      ['started_at', model.workflow.startedAt],
      ['done_at', model.workflow.doneAt],
      ['stale', model.workflow.stale]
    ])
  );

  lines.push(
    '',
    'Runtime',
    ...renderPairs([
      ['mode', model.runtime.mode],
      ['status', model.runtime.status],
      ['run', model.runtime.run],
      ['tmux', model.runtime.tmux],
      ['started_at', model.runtime.startedAt],
      ['finished_at', model.runtime.finishedAt],
      ['exit_code', model.runtime.exitCode],
      ['log', model.runtime.log]
    ])
  );

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

  return lines;
}

function modelTone(model: StatusModel): 'info' | 'success' | 'warning' | 'danger' | 'running' {
  if (model.orchestration.status === 'paused') return 'warning';
  if (model.orchestration.status === 'running') return 'running';
  if (model.orchestration.status === 'completed') return 'success';
  if (model.workflow.state === 'in-progress') return model.workflow.stale === 'yes' ? 'warning' : 'running';
  if (model.metadata.some(([key, value]) => key === 'status' && value === 'completed')) return 'success';
  if (model.metadata.some(([key, value]) => key === 'status' && (value === 'blocked' || value === 'cancelled'))) {
    return 'danger';
  }
  return 'info';
}

function buildFromResolved(input: BuildStatusModelInput): StatusModel {
  const content = fs.readFileSync(input.taskMdPath, 'utf8');
  const fm = parseTaskFrontmatter(content);
  const run = input.run ?? makeRunner(input.repoRoot);
  const artifacts = enumerateArtifacts(input.taskDir);
  const workflow = collectWorkflow(content, input.now);

  return {
    taskId: input.taskId,
    shortId: input.shortId ?? loadShortIdByTaskId(input.repoRoot).get(input.taskId) ?? DASH,
    title: extractTitle(content),
    metadata: collectMetadata(fm),
    workflowWarnings: getOpenWorkflowWarnings(content),
    artifacts: { count: artifacts.length, groups: groupArtifacts(artifacts) },
    workflow,
    runtime: collectRuntime(input.taskDir, workflow, run),
    orchestration: collectOrchestration(input.taskDir),
    git: collectGit(fm.branch ?? '', run)
  };
}

function buildStatusModel(ref: string, options?: BuildStatusModelOptions): StatusModel;
function buildStatusModel(input: BuildStatusModelInput): StatusModel;
function buildStatusModel(
  refOrInput: string | BuildStatusModelInput,
  options: BuildStatusModelOptions = {}
): StatusModel {
  if (typeof refOrInput !== 'string') {
    return buildFromResolved(refOrInput);
  }

  const resolved = resolveTaskRef(refOrInput);
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }

  return buildFromResolved({
    taskId: resolved.taskId,
    taskDir: resolved.taskDir,
    taskMdPath: resolved.taskMdPath,
    repoRoot: resolved.repoRoot,
    run: options.run,
    now: options.now
  });
}

function statusModelToDisplay(model: StatusModel): DisplayMessage {
  return statusCard(
    `Task ${model.taskId} (${model.shortId})`,
    modelTone(model),
    [
      ['orchestration', model.orchestration.status],
      ['run', model.orchestration.runId],
      ['next', model.orchestration.nextStage],
      ['workflow', model.workflow.state],
      ['step', model.workflow.step],
      ['runtime', model.runtime.status],
      ['git', model.git.uncommitted]
    ],
    renderStatus(model).join('\n')
  );
}

function status(args: string[] = []): void {
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  let model: StatusModel;
  try {
    const scope = parseTaskScope(args);
    if (scope.positionals.length > 0) {
      throw new Error('positional task ref is not supported; use --task <ref> or -t <ref>');
    }
    const resolved = resolveTaskContext(scope.taskRef);
    if (!resolved.ok) throw new Error(resolved.message);
    model = buildFromResolved({
      taskId: resolved.taskId, taskDir: resolved.taskDir, taskMdPath: resolved.taskMdPath,
      repoRoot: resolved.repoRoot
    });
  } catch (error) {
    process.stderr.write(`ai task status: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  for (const line of renderStatus(model)) {
    process.stdout.write(`${line}\n`);
  }
}

export {
  status,
  makeRunner,
  buildStatusModel,
  collectMetadata,
  groupArtifacts,
  collectGit,
  collectWorkflow,
  collectRuntime,
  collectOrchestration,
  renderStatus,
  statusModelToDisplay,
  METADATA_KEYS
};
export type { Runner, GitInfo, WorkflowInfo, RuntimeInfo, OrchestrationInfo, PendingDelegationInfo, StatusModel, BuildStatusModelInput };
