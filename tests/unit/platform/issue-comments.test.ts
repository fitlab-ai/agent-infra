import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  MARKERS,
  chunkArtifactComment,
  findMarkerComments,
  renderTaskComment,
  normalizeCommentContent,
  syncPlatformComment,
  validateRelatedMarkerSet
} from '../../../lib/platform/issue-comments.ts';
import type { GitHubClient } from '../../../lib/platform/github-client.ts';

test('task comments preserve frontmatter and body in reversible details format', () => {
  const task = '---\nid: TASK-20260101-000001\ntype: feature\n---\n\n# Task\n\nBody | `code`\n';
  const rendered = renderTaskComment(task, 'TASK-20260101-000001', 'codex');
  assert.equal(rendered.startsWith('<!-- sync-issue:TASK-20260101-000001:task -->\n'), true);
  assert.match(rendered, /<details><summary>元数据 \(frontmatter\)<\/summary>/);
  assert.match(rendered, /```yaml\n---\nid: TASK-20260101-000001\ntype: feature\n---\n```/);
  assert.match(rendered, /# Task\n\nBody \| `code`/);
});

test('artifact chunking is UTF-8 safe, bounded and lossless', () => {
  const body = `${'中文🙂'.repeat(80)}\n${'x'.repeat(120)}`;
  const chunks = chunkArtifactComment({
    taskId: 'TASK-20260101-000001', artifact: 'code.md', agent: 'codex', body, byteLimit: 240
  });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk.body, 'utf8') <= 240));
  assert.equal(chunks.map((chunk) => chunk.content).join(''), body);
  assert.equal(chunks[0]!.marker, MARKERS.artifactChunk('TASK-20260101-000001', 'code', 1, chunks.length));
});

test('artifact backfill adds a deterministic timeline hint without changing content', () => {
  const body = 'historical content\n';
  const [chunk] = chunkArtifactComment({
    taskId: 'TASK-20260101-000001', artifact: 'analysis.md', agent: 'codex', body, backfill: true
  });
  assert.match(chunk!.body, /## 需求分析（Round 1）\n\n> 历史产物补发\n/);
  assert.equal(chunk!.content, body);
});

test('marker lookup only accepts a complete first-line marker and reports duplicates', () => {
  const marker = MARKERS.artifact('TASK-20260101-000001', 'code');
  const comments = [
    { id: 1, body: `${marker}\nbody`, user: { login: 'a' } },
    { id: 2, body: `example ${marker}`, user: { login: 'b' } }
  ];
  assert.deepEqual(findMarkerComments(comments, marker).map((comment) => comment.id), [1]);
  assert.equal(normalizeCommentContent('a\r\n'), normalizeCommentContent('a\n\n'));
});

test('chunk marker validation rejects incomplete and contradictory sets', () => {
  const prefix = '<!-- sync-issue:TASK-20260101-000001:code';
  assert.equal(validateRelatedMarkerSet([
    { id: 1, body: `${prefix}:1/2 -->\na` },
    { id: 2, body: `${prefix}:2/2 -->\nb` }
  ], prefix).ok, true);
  assert.equal(validateRelatedMarkerSet([
    { id: 1, body: `${prefix}:1/2 -->\na` }
  ], prefix).code, 'COMMENT_MARKER_CONFLICT');
  assert.equal(validateRelatedMarkerSet([
    { id: 1, body: `${prefix} -->\na` },
    { id: 2, body: `${prefix}:1/1 -->\nb` }
  ], prefix).code, 'COMMENT_MARKER_CONFLICT');
  assert.equal(validateRelatedMarkerSet([
    { id: 1, body: `${prefix}:1/2 -->\na` },
    { id: 2, body: `${prefix}:1/2 -->\nb` }
  ], prefix).code, 'COMMENT_MARKER_CONFLICT');
  assert.equal(validateRelatedMarkerSet([
    { id: 1, body: `${prefix}:1/2 -->\na` },
    { id: 2, body: `${prefix}:2/3 -->\nb` }
  ], prefix).code, 'COMMENT_MARKER_CONFLICT');
});

function syncFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-comment-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: root });
  fs.mkdirSync(path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents', '.airc.json'), '{"platform":{"type":"github"}}');
  fs.writeFileSync(
    path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001', 'task.md'),
    '---\nid: TASK-20260101-000001\ntype: feature\nissue_number: 7\n---\n\n# Task\n'
  );
  fs.writeFileSync(
    path.join(root, '.agents', 'workspace', 'active', 'TASK-20260101-000001', 'analysis.md'),
    '# Analysis\n'
  );
  return root;
}

test('comment sync creates once and becomes a no-op on replay', () => {
  const root = syncFixture();
  const comments: Array<{ id: number; body: string; user: { login: string } }> = [];
  const client = {
    json(args: string[], options?: { input?: string }) {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
      if (endpoint === 'repos/acme/widgets') return { ok: true, value: { full_name: 'acme/widgets', permissions: { triage: true } } };
      if (args.at(-1) === 'user') return { ok: true, value: { login: 'codex' } };
      if (endpoint.endsWith('/comments?per_page=100')) return { ok: true, value: [comments] };
      if (args.includes('POST')) {
        const body = JSON.parse(options?.input || '{}').body;
        comments.push({ id: 10, body, user: { login: 'codex' } });
        return { ok: true, value: { id: 10 } };
      }
      throw new Error(`unexpected request: ${args.join(' ')}`);
    },
    text() { return { ok: true, value: '' }; }
  } as unknown as GitHubClient;

  const first = syncPlatformComment('TASK-20260101-000001', { kind: 'task', agent: 'codex', cwd: root, client });
  assert.equal(first.status, 'applied');
  assert.equal(first.changed, true);
  assert.equal(comments.length, 1);
  const second = syncPlatformComment('TASK-20260101-000001', { kind: 'task', agent: 'codex', cwd: root, client });
  assert.equal(second.status, 'no-op');
  assert.equal(second.changed, false);
  assert.equal(comments.length, 1);
});

test('comment sync refuses duplicate registered markers without writing', () => {
  const root = syncFixture();
  const marker = MARKERS.task('TASK-20260101-000001');
  const client = {
    json(args: string[]) {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
      if (endpoint === 'repos/acme/widgets') return { ok: true, value: { full_name: 'acme/widgets', permissions: {} } };
      if (args.at(-1) === 'user') return { ok: true, value: { login: 'codex' } };
      if (endpoint.endsWith('/comments?per_page=100')) return { ok: true, value: [[
        { id: 1, body: `${marker}\na`, user: { login: 'codex' } },
        { id: 2, body: `${marker}\nb`, user: { login: 'codex' } }
      ]] };
      throw new Error('write must not be attempted');
    },
    text() { throw new Error('write must not be attempted'); }
  } as unknown as GitHubClient;
  const result = syncPlatformComment('TASK-20260101-000001', { kind: 'task', agent: 'codex', cwd: root, client });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'COMMENT_MARKER_CONFLICT');
});

test('artifact sync isolates sibling stems and becomes a no-op on replay', () => {
  const root = syncFixture();
  const siblingBody = `${MARKERS.artifact('TASK-20260101-000001', 'analysis-r2')}\nexisting sibling`;
  const comments = [{ id: 20, body: siblingBody, user: { login: 'codex' } }];
  const client = {
    json(args: string[], options?: { input?: string }) {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
      if (endpoint === 'repos/acme/widgets') return { ok: true, value: { full_name: 'acme/widgets', permissions: { triage: true } } };
      if (args.at(-1) === 'user') return { ok: true, value: { login: 'codex' } };
      if (endpoint.endsWith('/comments?per_page=100')) return { ok: true, value: [comments] };
      if (args.includes('POST')) {
        const body = JSON.parse(options?.input || '{}').body;
        comments.push({ id: 21, body, user: { login: 'codex' } });
        return { ok: true, value: { id: 21 } };
      }
      throw new Error(`unexpected request: ${args.join(' ')}`);
    },
    text() { throw new Error('delete must not be attempted'); }
  } as unknown as GitHubClient;

  const options = { kind: 'artifact' as const, artifact: 'analysis.md', agent: 'codex', cwd: root, client };
  const first = syncPlatformComment('TASK-20260101-000001', options);
  assert.equal(first.status, 'applied');
  assert.equal(comments.length, 2);
  assert.deepEqual(comments[0], { id: 20, body: siblingBody, user: { login: 'codex' } });

  const second = syncPlatformComment('TASK-20260101-000001', options);
  assert.equal(second.status, 'no-op');
  assert.equal(comments.length, 2);
  assert.deepEqual(comments[0], { id: 20, body: siblingBody, user: { login: 'codex' } });
});

test('artifact sync refuses duplicate base markers without writing', () => {
  const root = syncFixture();
  const marker = MARKERS.artifact('TASK-20260101-000001', 'analysis');
  const client = {
    json(args: string[]) {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
      if (endpoint === 'repos/acme/widgets') return { ok: true, value: { full_name: 'acme/widgets', permissions: {} } };
      if (args.at(-1) === 'user') return { ok: true, value: { login: 'codex' } };
      if (endpoint.endsWith('/comments?per_page=100')) return { ok: true, value: [[
        { id: 1, body: `${marker}\na`, user: { login: 'codex' } },
        { id: 2, body: `${marker}\nb`, user: { login: 'codex' } }
      ]] };
      throw new Error('write must not be attempted');
    },
    text() { throw new Error('write must not be attempted'); }
  } as unknown as GitHubClient;

  const result = syncPlatformComment('TASK-20260101-000001', {
    kind: 'artifact', artifact: 'analysis.md', agent: 'codex', cwd: root, client
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'COMMENT_MARKER_CONFLICT');
});
