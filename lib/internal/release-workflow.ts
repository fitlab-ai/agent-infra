import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import semver from 'semver';

import { commitExplicitPaths, inspectGitWorkflow, pushGitRefs } from '../git/workflow.ts';
import { inspectPlatformRelease, reconcileReleaseMilestones } from '../platform/releases.ts';
import { inspectHomebrewChannel, inspectNpmChannel } from '../release/channels.ts';
import { releaseSnapshot } from '../release/workflow.ts';
import type { ReleaseFacts } from '../release/workflow.ts';

function command(cwd: string, executable: string, args: string[]) {
  return spawnSync(executable, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(cwd: string, args: string[]): string | null {
  const result = command(cwd, 'git', args);
  return result.status === 0 ? String(result.stdout).trim() : null;
}

async function inspectFacts(cwd: string, version: string): Promise<ReleaseFacts> {
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { name: string };
  const config = JSON.parse(fs.readFileSync(path.join(cwd, '.agents', '.airc.json'), 'utf8')) as { project: string; org: string };
  const tag = `v${version}`;
  const branch = git(cwd, ['branch', '--show-current']) || '';
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const localTagTarget = git(cwd, ['rev-parse', '--verify', `${tag}^{commit}`]);
  const remoteBranch = branch ? git(cwd, ['ls-remote', '--heads', 'origin', branch]) : null;
  const remoteTag = git(cwd, ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
  const platform = inspectPlatformRelease(tag, { cwd });
  const npm = await inspectNpmChannel(pkg.name, version);
  const formulaUrl = `https://raw.githubusercontent.com/${config.org}/homebrew-tap/main/Formula/${config.project}.rb`;
  const homebrew = await inspectHomebrewChannel(formulaUrl, version);
  const workflows = platform.workflows as Array<Record<string, unknown>>;
  const smokeRun = workflows.find((run) => String(run.name).toLowerCase().includes('post-release-smoke') && String(run.headBranch) === tag);
  const smoke = smokeRun ? String(smokeRun.conclusion) === 'success' ? 'success' : String(smokeRun.status) === 'completed' ? 'failed' : 'pending' : null;
  const postMessage = git(cwd, ['log', '-1', '--pretty=%s']) || '';
  return {
    localTag: Boolean(localTagTarget && localTagTarget === head),
    localTagConflict: Boolean(localTagTarget && localTagTarget !== head),
    remoteBranch: Boolean(remoteBranch && remoteBranch.split(/\s+/)[0] === head), remoteTag: Boolean(remoteTag),
    githubRelease: platform.status === 'blocked' ? null : Boolean(platform.release?.published),
    npm: npm.published, homebrew: homebrew.published, smoke,
    postCommit: postMessage.includes(`after v${version}`)
  };
}

function changedPaths(cwd: string): string[] {
  const output = git(cwd, ['status', '--porcelain=v1']) || '';
  return output.split('\n').filter(Boolean).map((line) => line.slice(3)).filter((value, index, all) => all.indexOf(value) === index);
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

async function releaseWorkflow(args: string[] = []): Promise<void> {
  const [action, rawVersion, ...rest] = args;
  const version = String(rawVersion || '').replace(/^v/, '');
  const cwdIndex = rest.indexOf('--cwd');
  const cwd = path.resolve(cwdIndex >= 0 && rest[cwdIndex + 1] ? rest[cwdIndex + 1]! : process.cwd());
  if (!['inspect', 'prepare', 'publish', 'post'].includes(action || '') || !semver.valid(version)) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, error: { code: 'RELEASE_INPUT_INVALID', message: 'Usage: release-workflow inspect|prepare|publish|post <version>' } })}\n`);
    process.exitCode = 1; return;
  }
  const before = releaseSnapshot(version, await inspectFacts(cwd, version));
  if (action === 'inspect') { process.stdout.write(`${JSON.stringify({ status: 'no-op', changed: false, snapshot: before, error: null })}\n`); return; }
  if (action === 'prepare') {
    if (before.facts.localTagConflict) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, snapshot: before, error: { code: 'GIT_TAG_CONFLICT', message: `Tag v${version} does not point to HEAD` } })}\n`);
      process.exitCode = 1;
      return;
    }
    if (before.phase !== 'unprepared') {
      const milestones = reconcileReleaseMilestones(version, { cwd });
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
    const milestones = tagged.status === 0 ? reconcileReleaseMilestones(version, { cwd }) : null;
    const snapshot = releaseSnapshot(version, await inspectFacts(cwd, version));
    const failed = tagged.status !== 0 || milestones?.status === 'failed';
    const blocked = milestones?.status === 'blocked';
    const status = failed ? 'failed' : blocked ? 'blocked' : 'applied';
    process.stdout.write(`${JSON.stringify({ status, changed: true, snapshot, operations: milestones?.operations ?? [], error: tagged.status !== 0 ? { code: 'GIT_TAG_FAILED', message: String(tagged.stderr) } : milestones?.error ?? null })}\n`);
    process.exitCode = failed ? 1 : blocked ? 2 : 0; return;
  }
  if (action === 'publish') {
    if (!['prepared', 'partially-published'].includes(before.phase)) { process.stdout.write(`${JSON.stringify({ status: 'failed', changed: false, snapshot: before, error: { code: 'RELEASE_PHASE_INVALID', message: `Cannot publish from ${before.phase}` } })}\n`); process.exitCode = 1; return; }
    const branch = git(cwd, ['branch', '--show-current']) || '';
    const refs = [...(!before.facts.remoteBranch ? [branch] : []), ...(!before.facts.remoteTag ? [`refs/tags/v${version}`] : [])];
    const result = pushGitRefs({ cwd, remote: 'origin', refs });
    process.stdout.write(`${JSON.stringify({ ...result, snapshot: releaseSnapshot(version, await inspectFacts(cwd, version)) })}\n`); process.exitCode = result.status === 'failed' ? 1 : result.status === 'degraded' ? 2 : 0; return;
  }
  const channelsComplete = before.facts.githubRelease === true && before.facts.npm === true && before.facts.homebrew === true;
  if (!['published', 'post-pending'].includes(before.phase) || !channelsComplete || before.facts.smoke !== 'success') {
    process.stdout.write(`${JSON.stringify({ status: before.facts.smoke === 'failed' ? 'failed' : 'blocked', changed: false, snapshot: before, error: { code: 'RELEASE_CHANNELS_PENDING', message: 'Release channels or smoke workflow are not complete' } })}\n`); process.exitCode = before.facts.smoke === 'failed' ? 1 : 2; return;
  }
  for (const [exe, commandArgs] of [['npm', ['run', 'build']], ['npm', ['version', 'prerelease', '--preid=alpha', '--no-git-tag-version']], ['npm', ['install', '--package-lock-only']], [process.execPath, ['scripts/build-inline.js']]] as Array<[string, string[]]>) {
    const result = command(cwd, exe, commandArgs); if (result.status !== 0) { process.stdout.write(`${JSON.stringify({ status: 'failed', changed: true, snapshot: before, error: { code: 'RELEASE_POST_COMMAND_FAILED', message: String(result.stderr || result.stdout) } })}\n`); process.exitCode = 1; return; }
  }
  const committed = commitExplicitPaths({ cwd, paths: changedPaths(cwd), message: `chore: prepare next dev iteration after v${version}` });
  if (committed.status === 'failed') { process.stdout.write(`${JSON.stringify(committed)}\n`); process.exitCode = 1; return; }
  const branch = git(cwd, ['branch', '--show-current']) || '';
  const pushed = pushGitRefs({ cwd, remote: 'origin', refs: [branch] });
  process.stdout.write(`${JSON.stringify({ ...pushed, snapshot: releaseSnapshot(version, await inspectFacts(cwd, version)) })}\n`); process.exitCode = pushed.status === 'failed' ? 1 : pushed.status === 'degraded' ? 2 : 0;
}

export { inspectFacts, releaseWorkflow };
