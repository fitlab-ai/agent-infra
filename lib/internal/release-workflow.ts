import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import semver from 'semver';

import { commitExplicitPaths, inspectGitWorkflow, pushGitRefs } from '../git/workflow.ts';
import { inspectPlatformRelease, reconcileReleaseMilestones } from '../platform/releases.ts';
import { inspectHomebrewChannel, inspectNpmChannel } from '../release/channels.ts';
import { releaseSnapshot } from '../release/workflow.ts';
import type { PostReleaseFacts, ReleaseFacts } from '../release/workflow.ts';

function command(cwd: string, executable: string, args: string[]) {
  return spawnSync(executable, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

type CommandResult = ReturnType<typeof command>;
type CommandRunner = (cwd: string, executable: string, args: string[]) => CommandResult;
type DemoResult = {
  status: 'recorded' | 'skipped' | 'failed';
  reasonCode: 'DEMO_INPUTS_UNCHANGED' | 'GIT_LFS_MISSING' | 'VHS_MISSING' | 'FFMPEG_MISSING'
    | 'DEMO_COMMAND_FAILED' | 'DEMO_OUTPUT_MISSING' | 'DEMO_OUTPUT_INVALID'
    | 'DEMO_OUTPUT_TOO_LARGE' | 'DEMO_DIGEST_FAILED' | null;
  message: string | null;
  outputPath: string | null;
};

// The tape is the canonical init interaction contract. Do not hash all of
// lib/init.ts: non-visual config serialization changes must not re-record it.
const DEMO_INPUT_PATHS = [
  'assets/demo-init.tape',
  'scripts/demo-regen.sh',
  'scripts/normalize-gif-duration.py',
  'bin/cli.ts',
  'lib/log.ts',
  'lib/prompt.ts',
  'lib/paths.ts',
  'lib/render.ts',
  'lib/sandbox/engines/'
] as const;
const DEMO_DIGEST_PATH = 'assets/demo-init.inputs.sha256';
const DEMO_OUTPUT_PATH = 'assets/demo-init.gif';
const DEMO_MAX_BYTES = 4 * 1024 * 1024;

function demoInputFiles(cwd: string): string[] {
  const files = new Set<string>();
  for (const input of DEMO_INPUT_PATHS) {
    if (input.endsWith('/')) {
      const listed = command(cwd, 'git', ['ls-files', '--', input]);
      if (listed.status !== 0) throw new Error(String(listed.stderr || `Unable to list ${input}`));
      const directoryFiles = String(listed.stdout).split('\n').filter(Boolean);
      if (!directoryFiles.length) throw new Error(`Canonical demo input directory is empty: ${input}`);
      for (const file of directoryFiles) files.add(file.replaceAll('\\', '/'));
    } else {
      files.add(input);
    }
  }
  const sorted = [...files].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (!sorted.length) throw new Error('Canonical demo input set is empty');
  for (const file of sorted) {
    const absolute = path.join(cwd, file);
    if (!fs.statSync(absolute).isFile()) throw new Error(`Canonical demo input is not a file: ${file}`);
  }
  return sorted;
}

function computeDemoInputDigest(cwd: string): string {
  const hash = crypto.createHash('sha256');
  for (const file of demoInputFiles(cwd)) {
    const bytes = fs.readFileSync(path.join(cwd, file));
    hash.update(file);
    hash.update('\0');
    hash.update(String(bytes.byteLength));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function validGif(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const header = fs.readFileSync(filePath).subarray(0, 6).toString('ascii');
  return header === 'GIF87a' || header === 'GIF89a';
}

function writeDigestAtomically(cwd: string, digest: string): void {
  const target = path.join(cwd, DEMO_DIGEST_PATH);
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${digest}\n`);
  fs.renameSync(temporary, target);
}

function runOptionalDemo(cwd: string, run: CommandRunner = command): DemoResult {
  let digest: string;
  try {
    digest = computeDemoInputDigest(cwd);
  } catch (error) {
    return { status: 'failed', reasonCode: 'DEMO_DIGEST_FAILED', message: String(error), outputPath: null };
  }
  const digestPath = path.join(cwd, DEMO_DIGEST_PATH);
  const priorDigest = fs.existsSync(digestPath) ? fs.readFileSync(digestPath, 'utf8').trim() : '';
  if (/^[0-9a-f]{64}$/.test(priorDigest) && priorDigest === digest) {
    return { status: 'skipped', reasonCode: 'DEMO_INPUTS_UNCHANGED', message: null, outputPath: null };
  }
  const lfs = run(cwd, 'git', ['lfs', 'version']);
  if (lfs.status !== 0) {
    return { status: 'failed', reasonCode: 'GIT_LFS_MISSING', message: String(lfs.stderr || lfs.stdout), outputPath: null };
  }
  const lfsAttribute = run(cwd, 'git', ['check-attr', 'filter', '--', DEMO_OUTPUT_PATH]);
  if (lfsAttribute.status !== 0 || !String(lfsAttribute.stdout).trim().endsWith(': lfs')) {
    return { status: 'failed', reasonCode: 'GIT_LFS_MISSING', message: `${DEMO_OUTPUT_PATH} is not tracked by Git LFS`, outputPath: null };
  }
  const vhs = run(cwd, 'vhs', ['--version']);
  if (vhs.status !== 0) return { status: 'skipped', reasonCode: 'VHS_MISSING', message: null, outputPath: null };
  const ffmpeg = run(cwd, 'ffmpeg', ['-version']);
  if (ffmpeg.status !== 0) return { status: 'skipped', reasonCode: 'FFMPEG_MISSING', message: null, outputPath: null };
  const demo = run(cwd, 'npm', ['run', 'demo:regen']);
  if (demo.status !== 0) {
    return {
      status: 'failed',
      reasonCode: 'DEMO_COMMAND_FAILED',
      message: String(demo.stderr || demo.stdout),
      outputPath: null
    };
  }
  const outputPath = DEMO_OUTPUT_PATH;
  if (!fs.existsSync(path.join(cwd, outputPath))) {
    return {
      status: 'failed',
      reasonCode: 'DEMO_OUTPUT_MISSING',
      message: `${outputPath} was not generated`,
      outputPath: null
    };
  }
  const absoluteOutput = path.join(cwd, outputPath);
  if (!validGif(absoluteOutput)) {
    return { status: 'failed', reasonCode: 'DEMO_OUTPUT_INVALID', message: `${outputPath} is not a GIF`, outputPath: null };
  }
  if (fs.statSync(absoluteOutput).size > DEMO_MAX_BYTES) {
    return { status: 'failed', reasonCode: 'DEMO_OUTPUT_TOO_LARGE', message: `${outputPath} exceeds 4 MiB`, outputPath: null };
  }
  const pointer = run(cwd, 'git', ['lfs', 'pointer', `--file=${outputPath}`]);
  if (pointer.status !== 0 || !String(pointer.stdout).includes(`size ${fs.statSync(absoluteOutput).size}`)) {
    return { status: 'failed', reasonCode: 'DEMO_OUTPUT_INVALID', message: 'Git LFS could not produce a matching pointer', outputPath: null };
  }
  writeDigestAtomically(cwd, digest);
  return { status: 'recorded', reasonCode: null, message: null, outputPath };
}

function git(cwd: string, args: string[], run: CommandRunner = command, trim = true): string | null {
  const result = run(cwd, 'git', args);
  const stdout = String(result.stdout);
  return result.status === 0 ? (trim ? stdout.trim() : stdout) : null;
}

function inspectLocalReleaseFacts(cwd: string, version: string, run: CommandRunner = command) {
  const tag = `v${version}`;
  const head = git(cwd, ['rev-parse', 'HEAD'], run);
  const tagCommit = git(cwd, ['rev-parse', '--verify', `${tag}^{commit}`], run);
  const localTag = Boolean(tagCommit && tagCommit === head);
  const localTagAncestor = Boolean(
    tagCommit && head && !localTag
    && run(cwd, 'git', ['merge-base', '--is-ancestor', tagCommit, head]).status === 0
  );
  const localTagConflict = Boolean(tagCommit && !localTag && !localTagAncestor);
  const postSubject = `chore: prepare next dev iteration after v${version}`;
  const postLog = localTag || localTagAncestor
    ? git(cwd, ['log', '--format=%H%x00%s', `${tag}..HEAD`], run) ?? ''
    : '';
  const postCommit = postLog.split('\n').map((line) => line.split('\0'))
    .find(([, subject]) => subject === postSubject)?.[0] ?? null;
  return { localTag, localTagAncestor, localTagConflict, postCommit };
}

function inspectPostReleaseFacts(
  cwd: string,
  commit: string | null,
  run: CommandRunner = command
): PostReleaseFacts {
  const inspected = inspectGitWorkflow(cwd);
  const snapshot = inspected.snapshot;
  const branch = snapshot?.branch ?? '';
  const remoteLine = branch ? git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], run) : null;
  const remoteHead = remoteLine?.split(/\s+/)[0] ?? null;
  const packageJson = commit ? git(cwd, ['show', `${commit}:package.json`], run, false) : null;
  let newVersion: string | null = null;
  if (packageJson) {
    try {
      const version = (JSON.parse(packageJson) as { version?: unknown }).version;
      newVersion = typeof version === 'string' ? version : null;
    } catch {
      newVersion = null;
    }
  }
  const paths = commit ? git(cwd, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', commit], run, false) : null;
  const changedPaths = paths ? paths.split('\0').filter(Boolean)
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right))) : [];
  const digest = commit ? git(cwd, ['show', `${commit}:${DEMO_DIGEST_PATH}`], run) : null;
  return {
    commit,
    isHead: Boolean(commit && snapshot?.head === commit),
    published: Boolean(commit && remoteHead === commit),
    branch,
    upstream: snapshot?.upstream ?? null,
    remoteHead,
    newVersion,
    changedPaths,
    demoInputSha256: digest && /^[0-9a-f]{64}$/.test(digest) ? digest : null,
    worktree: snapshot?.worktree ?? [],
    staged: snapshot?.staged ?? []
  };
}

function releaseSmokeStatus(workflows: Array<Record<string, unknown>>, version: string, tagCommit: string | null): ReleaseFacts['smoke'] {
  const manualTitle = `Post-Release Smoke v${version}`;
  const targets = workflows.filter((run) => {
    if (String(run.workflowName || run.name) !== 'Post-Release Smoke') return false;
    if (String(run.event) === 'workflow_run') return Boolean(tagCommit && String(run.headSha) === tagCommit);
    return String(run.event) === 'workflow_dispatch' && String(run.displayTitle) === manualTitle;
  }).sort((left, right) => {
    const leftOrder = [Date.parse(String(left.createdAt || '')) || 0, Number(left.databaseId) || 0, Number(left.attempt) || 0];
    const rightOrder = [Date.parse(String(right.createdAt || '')) || 0, Number(right.databaseId) || 0, Number(right.attempt) || 0];
    for (let index = 0; index < leftOrder.length; index += 1) {
      if (leftOrder[index] !== rightOrder[index]) return rightOrder[index]! - leftOrder[index]!;
    }
    return 0;
  });
  const latest = targets[0];
  if (!latest) return null;
  if (String(latest.status) !== 'completed') return 'pending';
  return String(latest.conclusion) === 'success' ? 'success' : 'failed';
}

function inspectPostWorktree(cwd: string) {
  const inspected = inspectGitWorkflow(cwd);
  if (!inspected.snapshot) return inspected.error ?? { code: 'GIT_INSPECT_FAILED', message: 'Unable to inspect Git repository' };
  if (inspected.snapshot.worktree.length || inspected.snapshot.staged.length) {
    return { code: 'WORKTREE_DIRTY', message: 'Release post requires a clean worktree' };
  }
  return null;
}

async function inspectFacts(cwd: string, version: string): Promise<ReleaseFacts> {
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { name: string };
  const config = JSON.parse(fs.readFileSync(path.join(cwd, '.agents', '.airc.json'), 'utf8')) as { project: string; org: string };
  const tag = `v${version}`;
  const branch = git(cwd, ['branch', '--show-current']) || '';
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const localTagTarget = git(cwd, ['rev-parse', '--verify', `${tag}^{commit}`]);
  const local = inspectLocalReleaseFacts(cwd, version);
  const remoteBranch = branch ? git(cwd, ['ls-remote', '--heads', 'origin', branch]) : null;
  const remoteTag = git(cwd, ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
  const platform = await inspectPlatformRelease(tag, { cwd });
  const npm = await inspectNpmChannel(pkg.name, version);
  const formulaUrl = `https://raw.githubusercontent.com/${config.org}/homebrew-tap/main/Formula/${config.project}.rb`;
  const homebrew = await inspectHomebrewChannel(formulaUrl, version);
  const workflows = platform.workflows as Array<Record<string, unknown>>;
  const smoke = releaseSmokeStatus(workflows, version, localTagTarget);
  return {
    localTag: local.localTag,
    localTagAncestor: local.localTagAncestor,
    localTagConflict: local.localTagConflict,
    remoteBranch: Boolean(remoteBranch && remoteBranch.split(/\s+/)[0] === head), remoteTag: Boolean(remoteTag),
    githubRelease: platform.platform.type !== 'github'
      ? true
      : platform.status === 'blocked' ? null : Boolean(platform.release?.published),
    npm: npm.published, homebrew: homebrew.published, smoke,
    post: inspectPostReleaseFacts(cwd, local.postCommit)
  };
}

function parsePorcelainPath(record: string): string {
  const match = /^.. (.+)$/.exec(record);
  if (!match) throw new Error('Invalid git status --porcelain=v1 record');
  return match[1]!;
}

function changedPaths(cwd: string, run: CommandRunner = command): string[] {
  const output = git(cwd, ['status', '--porcelain=v1'], run, false) || '';
  return output.split(/\r?\n/).filter(Boolean).map(parsePorcelainPath).filter((value, index, all) => all.indexOf(value) === index);
}

function updateReleaseMetadata(cwd: string, version: string): void {
  const [major = '0', minor = '0'] = version.split('.');
  const aircPath = path.join(cwd, '.agents', '.airc.json');
  const airc = JSON.parse(fs.readFileSync(aircPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(aircPath, `${JSON.stringify({ ...airc, templateVersion: `v${version}` }, null, 2)}\n`);
  for (const [fileName, supported, unsupported] of [
    ['SECURITY.md', `| v${major}.${minor}.x   | Supported             |`, `| < v${major}.${minor}.0 | Not Supported         |`],
    ['SECURITY.zh-CN.md', `| v${major}.${minor}.x   | 支持中                |`, `| < v${major}.${minor}.0 | 不再支持              |`]
  ] as const) {
    const filePath = path.join(cwd, fileName);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8')
      .replace(/^\| v\d+\.\d+\.x\s+\| (?:Supported|支持中)\s+\|$/m, supported)
      .replace(/^\| < v\d+\.\d+\.0\s+\| (?:Not Supported|不再支持)\s+\|$/m, unsupported);
    fs.writeFileSync(filePath, content);
  }
}

function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(args[index + 1] ?? '');
  }
  return values;
}

async function releaseWorkflow(args: string[] = []): Promise<void> {
  const [action, rawVersion, ...rest] = args;
  const version = String(rawVersion || '').replace(/^v/, '');
  const cwdIndex = rest.indexOf('--cwd');
  const cwd = path.resolve(cwdIndex >= 0 && rest[cwdIndex + 1] ? rest[cwdIndex + 1]! : process.cwd());
  if (!['inspect', 'prepare', 'publish', 'post-prepare', 'post-publish'].includes(action || '') || !semver.valid(version)) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'RELEASE_INPUT_INVALID', message: 'Usage: release-workflow inspect|prepare|publish|post-prepare|post-publish <version>' } })}\n`);
    process.exitCode = 1; return;
  }
  const before = releaseSnapshot(version, await inspectFacts(cwd, version));
  if (action === 'inspect') { process.stdout.write(`${JSON.stringify({ status: 'no-op', changed: false, snapshot: before, error: null })}\n`); return; }
  if (before.facts.localTagConflict) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, snapshot: before, error: { code: 'GIT_TAG_CONFLICT', message: `Tag v${version} is not reachable from HEAD` } })}\n`);
    process.exitCode = 1; return;
  }
  if (action === 'prepare') {
    if (before.phase !== 'unprepared') {
      const milestones = await reconcileReleaseMilestones(version, { cwd });
      process.stdout.write(`${JSON.stringify({ ...milestones, snapshot: before })}\n`);
      process.exitCode = milestones.status === 'failed' ? 1 : milestones.status === 'blocked' ? 2 : 0;
      return;
    }
    const entropyIndex = rest.indexOf('--entropy-report');
    const entropy = entropyIndex >= 0 ? rest[entropyIndex + 1] : null;
    if (!entropy || !fs.existsSync(path.resolve(cwd, entropy))) { process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, snapshot: before, error: { code: 'ENTROPY_REPORT_REQUIRED', message: '--entropy-report must reference an existing report' } })}\n`); process.exitCode = 1; return; }
    const entropyContent = fs.readFileSync(path.resolve(cwd, entropy), 'utf8');
    const blockingCount = Number(/^\|\s*release-blocking\s*\|\s*(\d+)\s*\|/m.exec(entropyContent)?.[1] ?? NaN);
    if (!Number.isFinite(blockingCount) || blockingCount > 0) { process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, snapshot: before, error: { code: 'ENTROPY_REPORT_BLOCKING', message: 'Entropy report is invalid or contains release-blocking findings' } })}\n`); process.exitCode = 1; return; }
    const inspected = inspectGitWorkflow(cwd);
    if (!inspected.snapshot || inspected.snapshot.worktree.length || inspected.snapshot.staged.length) { process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, snapshot: before, error: { code: 'WORKTREE_DIRTY', message: 'Release prepare requires a clean worktree' } })}\n`); process.exitCode = 1; return; }
    for (const [exe, commandArgs] of [['npm', ['test']], ['npm', ['version', version, '--no-git-tag-version']], ['npm', ['install', '--package-lock-only']], [process.execPath, ['scripts/build-inline.js']]] as Array<[string, string[]]>) {
      if (exe === process.execPath) updateReleaseMetadata(cwd, version);
      const result = command(cwd, exe, commandArgs); if (result.status !== 0) { process.stdout.write(`${JSON.stringify({ status: 'failed', changed: true, snapshot: before, error: { code: 'RELEASE_PREPARE_COMMAND_FAILED', message: String(result.stderr || result.stdout) } })}\n`); process.exitCode = 1; return; }
    }
    const committed = commitExplicitPaths({ cwd, paths: changedPaths(cwd), message: `chore: release v${version}` });
    if (committed.status === 'failed') { process.stdout.write(`${JSON.stringify(committed)}\n`); process.exitCode = 1; return; }
    const tagged = command(cwd, 'git', ['tag', '-a', `v${version}`, '-m', `Release v${version}`]);
    const milestones = tagged.status === 0 ? await reconcileReleaseMilestones(version, { cwd }) : null;
    const snapshot = releaseSnapshot(version, await inspectFacts(cwd, version));
    const failed = tagged.status !== 0 || milestones?.status === 'failed';
    const blocked = milestones?.status === 'blocked';
    const status = failed ? 'failed' : blocked ? 'blocked' : 'applied';
    process.stdout.write(`${JSON.stringify({ status, changed: true, snapshot, operations: milestones?.operations ?? [], error: tagged.status !== 0 ? { code: 'GIT_TAG_FAILED', message: String(tagged.stderr) } : milestones?.error ?? null })}\n`);
    process.exitCode = failed ? 1 : blocked ? 2 : 0; return;
  }
  if (action === 'publish') {
    if (!before.facts.localTag || !['prepared', 'partially-published'].includes(before.phase)) { process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, snapshot: before, error: { code: 'RELEASE_PHASE_INVALID', message: `Cannot publish from ${before.phase}` } })}\n`); process.exitCode = 1; return; }
    const branch = git(cwd, ['branch', '--show-current']) || '';
    const refs = [...(!before.facts.remoteBranch ? [branch] : []), ...(!before.facts.remoteTag ? [`refs/tags/v${version}`] : [])];
    const result = pushGitRefs({ cwd, remote: 'origin', refs });
    process.stdout.write(`${JSON.stringify({ ...result, snapshot: releaseSnapshot(version, await inspectFacts(cwd, version)) })}\n`); process.exitCode = result.status === 'failed' ? 1 : result.status === 'degraded' ? 2 : 0; return;
  }
  if (action === 'post-publish') {
    const expectedValues = optionValues(rest, '--expected-sha256');
    if (expectedValues.length !== 1 || !/^sha256:[0-9a-f]{64}$/.test(expectedValues[0]!)) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, snapshot: before, error: { code: 'RELEASE_INPUT_INVALID', message: 'post-publish requires one --expected-sha256 sha256:<64 hex>' } })}\n`);
      process.exitCode = 1; return;
    }
    if (before.phase === 'complete') {
      process.stdout.write(`${JSON.stringify({ status: 'no-op', changed: false, snapshot: before, error: null })}\n`);
      return;
    }
    const confirmation = 'postConfirmation' in before ? before.postConfirmation : null;
    if (before.phase !== 'post-prepared' || !confirmation) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, snapshot: before, error: { code: confirmation ? 'RELEASE_PHASE_INVALID' : 'RELEASE_POST_CONFIRMATION_UNAVAILABLE', message: 'Post-release facts cannot authorize publish' } })}\n`);
      process.exitCode = 1; return;
    }
    if (confirmation.sha256 !== expectedValues[0]) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, snapshot: before, error: { code: 'RELEASE_POST_SNAPSHOT_MISMATCH', message: 'Post-release confirmation snapshot changed' } })}\n`);
      process.exitCode = 1; return;
    }
    const channelsComplete = before.facts.githubRelease === true && before.facts.npm === true && before.facts.homebrew === true;
    if (!channelsComplete || before.facts.smoke !== 'success') {
      process.stdout.write(`${JSON.stringify({ status: before.facts.smoke === 'failed' ? 'failed' : 'blocked', changed: false, snapshot: before, error: { code: 'RELEASE_CHANNELS_PENDING', message: 'Release channels or smoke workflow are not complete' } })}\n`);
      process.exitCode = before.facts.smoke === 'failed' ? 1 : 2; return;
    }
    const pushed = pushGitRefs({ cwd, remote: 'origin', refs: [before.facts.post.branch] });
    const snapshot = releaseSnapshot(version, await inspectFacts(cwd, version));
    if (snapshot.phase === 'complete') {
      process.stdout.write(`${JSON.stringify({ ...pushed, status: 'applied', changed: true, snapshot, error: null })}\n`);
      return;
    }
    const blocked = pushed.status !== 'failed';
    process.stdout.write(`${JSON.stringify({ ...pushed, status: blocked ? 'blocked' : 'failed', snapshot, error: pushed.error ?? { code: 'RELEASE_PROGRESS_PENDING', message: 'Post-release push is not visible at the expected remote head' } })}\n`);
    process.exitCode = blocked ? 2 : 1; return;
  }

  if (before.phase === 'complete') {
    process.stdout.write(`${JSON.stringify({ status: 'no-op', changed: false, snapshot: before, error: null })}\n`);
    return;
  }
  if (before.phase === 'post-prepared') {
    const confirmation = 'postConfirmation' in before ? before.postConfirmation : null;
    const status = confirmation ? 'no-op' : 'blocked';
    process.stdout.write(`${JSON.stringify({ status, changed: false, snapshot: before, error: confirmation ? null : { code: 'RELEASE_POST_CONFIRMATION_UNAVAILABLE', message: 'Post commit is not the clean current HEAD' } })}\n`);
    process.exitCode = confirmation ? 0 : 2; return;
  }
  const channelsComplete = before.facts.githubRelease === true && before.facts.npm === true && before.facts.homebrew === true;
  if (!['published', 'post-pending'].includes(before.phase) || !channelsComplete || before.facts.smoke !== 'success') {
    process.stdout.write(`${JSON.stringify({ status: before.facts.smoke === 'failed' ? 'failed' : 'blocked', changed: false, snapshot: before, error: { code: 'RELEASE_CHANNELS_PENDING', message: 'Release channels or smoke workflow are not complete' } })}\n`); process.exitCode = before.facts.smoke === 'failed' ? 1 : 2; return;
  }
  const worktreeError = inspectPostWorktree(cwd);
  if (worktreeError) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, snapshot: before, error: worktreeError })}\n`);
    process.exitCode = 1; return;
  }
  const built = command(cwd, 'npm', ['run', 'build']);
  if (built.status !== 0) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: true, snapshot: before, error: { code: 'RELEASE_POST_COMMAND_FAILED', message: String(built.stderr || built.stdout) } })}\n`);
    process.exitCode = 1; return;
  }
  const demo = runOptionalDemo(cwd);
  if (demo.status === 'failed') {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: true, snapshot: before, demo, error: { code: 'RELEASE_POST_DEMO_FAILED', message: demo.message } })}\n`);
    process.exitCode = 1; return;
  }
  for (const [exe, commandArgs] of [['npm', ['version', 'prerelease', '--preid=alpha', '--no-git-tag-version']], ['npm', ['install', '--package-lock-only']], [process.execPath, ['scripts/build-inline.js']]] as Array<[string, string[]]>) {
    const result = command(cwd, exe, commandArgs); if (result.status !== 0) { process.stdout.write(`${JSON.stringify({ status: 'failed', changed: true, snapshot: before, error: { code: 'RELEASE_POST_COMMAND_FAILED', message: String(result.stderr || result.stdout) } })}\n`); process.exitCode = 1; return; }
  }
  const committed = commitExplicitPaths({ cwd, paths: changedPaths(cwd), message: `chore: prepare next dev iteration after v${version}` });
  if (committed.status === 'failed') { process.stdout.write(`${JSON.stringify(committed)}\n`); process.exitCode = 1; return; }
  const snapshot = releaseSnapshot(version, await inspectFacts(cwd, version));
  const confirmation = 'postConfirmation' in snapshot ? snapshot.postConfirmation : null;
  if (snapshot.phase !== 'post-prepared' || !confirmation) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: true, demo, snapshot, error: { code: 'RELEASE_POST_CONFIRMATION_UNAVAILABLE', message: 'Prepared post commit did not produce a confirmation snapshot' } })}\n`);
    process.exitCode = 1; return;
  }
  process.stdout.write(`${JSON.stringify({ status: 'applied', changed: true, demo, snapshot, error: null })}\n`);
}

export { changedPaths, computeDemoInputDigest, inspectFacts, inspectLocalReleaseFacts, inspectPostReleaseFacts, inspectPostWorktree, releaseSmokeStatus, releaseWorkflow, runOptionalDemo };
export type { CommandRunner, DemoResult };
