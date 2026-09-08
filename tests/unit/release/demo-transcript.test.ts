import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEMO_COLUMNS,
  DEMO_ROWS,
  normalizeVisibleTranscript,
  sha256Transcript
} from '../../../lib/internal/demo-transcript.ts';

test('visible transcript normalization applies terminal editing semantics', () => {
  const raw = [
    '\u001b[2Jready',
    '\u001b[2K\rnew',
    '\u001b[3;1Hname: old\u001b[3;7Hnew',
    '\u001b[4;1Hdir\t✓',
    '\u001b]0;ignored title\u0007'
  ].join('\n');

  const normalized = normalizeVisibleTranscript(raw);

  assert.match(normalized, /ready/);
  assert.match(normalized, /name: new/);
  assert.match(normalized, /dir\s+✓/);
  assert.doesNotMatch(normalized, /ignored title/);
});

test('normalization is independent of control sequence chunk boundaries and temporary paths', () => {
  const one = normalizeVisibleTranscript('cd /tmp/agent-infra-demo-project-123\r\u001b[2Kdemo /tmp/agent-infra-demo-project-123');
  const two = normalizeVisibleTranscript(['cd /tmp/agent-', 'infra-demo-project-456', '\r\u001b[2', 'Kdemo /tmp/agent-infra-demo-project-456'].join(''));

  assert.equal(one, two);
});

test('transcript hash is SHA-256 and terminal dimensions are fixed', () => {
  assert.equal(DEMO_COLUMNS, 128);
  assert.equal(DEMO_ROWS, 40);
  assert.match(sha256Transcript('visible\n'), /^[0-9a-f]{64}$/);
  assert.notEqual(sha256Transcript('visible\n'), sha256Transcript('changed\n'));
});

test('normalization preserves visible prompt changes', () => {
  assert.notEqual(
    normalizeVisibleTranscript('release-host-one$ visible\n'),
    normalizeVisibleTranscript('release-host-two$ visible\n')
  );
});

test('canonical transcript covers the fixed init prompts and generated tree', () => {
  const transcriptPath = path.resolve('assets/demo-init.transcript');
  const digestPath = path.resolve('assets/demo-init.transcript.sha256');
  const transcript = fs.readFileSync(transcriptPath, 'utf8');
  assert.equal(fs.readFileSync(digestPath, 'utf8').trim(), sha256Transcript(transcript));
  for (const visibleText of [
    'demo$ cd /tmp/my-awesome-project',
    'demo$ git init -q && git remote add origin git@github.com:acme-corp/my-awesome-project.git',
    'demo$ ai init',
    'Project name', 'Organization / owner', 'Language', 'Sandbox engine', 'Platform',
    'Agent Client project integrations', 'Template sources', 'Skill sources',
    'Project initialized successfully!',
    'demo$ tree .agents/ .claude/ .opencode/ -L 2 --dirsfirst',
    '.agents/', '.claude/', '.opencode/', '9 directories, 2 files'
  ]) assert.match(transcript, new RegExp(visibleText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
