import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cliArgs, envWithPrependedPath, gitSafeEnv, writeSandboxEngineFixture } from '../../helpers.ts';

// clack renders section headers (p.log.step) on stdout prefixed with this glyph.
const STEP_GLYPH = '◇'; // ◇

function spawnSandboxCli(
  fixture: ReturnType<typeof writeSandboxEngineFixture>,
  tmpDir: string,
  args: string[]
) {
  return spawnSync(process.execPath, cliArgs('sandbox', ...args), {
    cwd: fixture.repoDir,
    env: {
      ...envWithPrependedPath(gitSafeEnv(), fixture.binDir),
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      DOCKER_LOG_PATH: fixture.logPath
    },
    encoding: 'utf8'
  });
}

function sandboxRow(name: string, branch: string, project = 'demo'): string {
  return `${name}\tUp 1 minute\t${project}.sandbox.branch=${branch},${project}.sandbox=true`;
}

test('ai sandbox ls shows only the Containers section (no worktree/state sections)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-ls-compact-'));
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, {
      project: 'demo',
      dockerStdoutForPs: sandboxRow('sb-feature-x', 'feature-x')
    });

    // Create worktree + tool state dirs that the OLD ls would have printed as
    // extra sections; the compact ls must not surface them.
    fs.mkdirSync(path.join(tmpDir, '.agent-infra', 'worktrees', 'demo', 'feature-x'), {
      recursive: true
    });
    fs.mkdirSync(path.join(tmpDir, '.agent-infra', 'sandboxes', 'claude-code', 'demo', 'feature-x'), {
      recursive: true
    });

    const result = spawnSandboxCli(fixture, tmpDir, ['ls']);

    assert.equal(result.status, 0, result.stderr);

    // Container table (rows + Total) is written to stdout.
    assert.match(result.stdout, /NAMES/);
    assert.match(result.stdout, /STATUS/);
    assert.match(result.stdout, /BRANCH/);
    assert.match(result.stdout, /feature-x/);
    assert.match(result.stdout, /Total: 1 containers/);

    // Exactly one clack section header is emitted (Containers), proving the
    // worktree and per-tool state sections are gone. Positive count assertion
    // (not a reverse "does not contain Worktrees" check).
    const sectionCount = (result.stdout.match(new RegExp(STEP_GLYPH, 'g')) || []).length;
    assert.equal(sectionCount, 1, `expected exactly one section, got ${sectionCount}: ${result.stdout}`);
    assert.match(result.stdout, new RegExp(`${STEP_GLYPH}\\s+Containers`));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ai sandbox ls reports an empty state with no extra sections', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-ls-empty-'));
  try {
    const fixture = writeSandboxEngineFixture(tmpDir, { project: 'demo', dockerStdoutForPs: '' });

    const result = spawnSandboxCli(fixture, tmpDir, ['ls']);

    assert.equal(result.status, 0, result.stderr);
    const sectionCount = (result.stdout.match(new RegExp(STEP_GLYPH, 'g')) || []).length;
    assert.equal(sectionCount, 1, `expected exactly one section, got ${sectionCount}: ${result.stdout}`);
    assert.match(result.stdout, new RegExp(`${STEP_GLYPH}\\s+Containers`));
    assert.match(result.stdout, /No sandbox containers/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
