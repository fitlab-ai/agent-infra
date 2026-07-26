import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasPlatformCapability,
  inspectPlatformChangeRequest,
  inspectPlatformRequiredChecks,
  registerPlatformAdapter
} from '../../../lib/platform/adapters.ts';
import { platformResult } from '../../../lib/platform/types.ts';

test('registered platform adapters provide normalized change-request and required-check snapshots', () => {
  registerPlatformAdapter({
    type: 'custom-inspection-test',
    resolveContext() {
      return platformResult('no-op', {
        platform: { type: 'custom-inspection-test', repository: 'acme/widgets', currentUser: 'reviewer' }
      });
    },
    inspectChangeRequest({ number }) {
      return {
        ok: true,
        value: {
          repository: 'acme/widgets',
          number,
          nodeId: 'change-42',
          url: 'https://code.example/acme/widgets/changes/42',
          state: 'closed',
          title: 'Change 42',
          body: '',
          draft: false,
          head: { repository: 'acme/widgets', ref: 'topic', sha: 'a'.repeat(40) },
          base: { repository: 'acme/widgets', ref: 'main', sha: 'b'.repeat(40) },
          mergedAt: '2026-07-26T10:00:00Z',
          mergeCommitSha: 'c'.repeat(40),
          labels: [],
          assignees: [],
          milestone: null
        }
      };
    },
    inspectRequiredChecks() {
      return {
        ok: true,
        value: [{
          name: 'build',
          bucket: 'pass',
          workflow: 'CI',
          conclusion: 'success',
          detailsUrl: 'https://code.example/checks/1',
          startedAt: null,
          completedAt: null
        }]
      };
    }
  });

  assert.equal(hasPlatformCapability('custom-inspection-test', 'change-request'), true);
  assert.equal(hasPlatformCapability('custom-inspection-test', 'required-checks'), true);
  assert.equal(inspectPlatformChangeRequest('custom-inspection-test', {
    cwd: process.cwd(),
    repository: 'acme/widgets',
    number: 42
  }).value?.mergeCommitSha, 'c'.repeat(40));
  assert.deepEqual(inspectPlatformRequiredChecks('custom-inspection-test', {
    cwd: process.cwd(),
    repository: 'acme/widgets',
    number: 42,
    headSha: 'a'.repeat(40)
  }).value, [{
    name: 'build',
    bucket: 'pass',
    workflow: 'CI',
    conclusion: 'success',
    detailsUrl: 'https://code.example/checks/1',
    startedAt: null,
    completedAt: null
  }]);
});

test('missing inspection capabilities return an explicit unsupported result', () => {
  registerPlatformAdapter({
    type: 'context-only-test',
    resolveContext() {
      return platformResult('no-op', {
        platform: { type: 'context-only-test', repository: 'acme/widgets', currentUser: null }
      });
    }
  });

  assert.equal(hasPlatformCapability('context-only-test', 'change-request'), false);
  assert.equal(hasPlatformCapability('context-only-test', 'required-checks'), false);
  assert.equal(inspectPlatformChangeRequest('context-only-test', {
    cwd: process.cwd(),
    repository: 'acme/widgets',
    number: 7
  }).error?.code, 'PLATFORM_CAPABILITY_UNSUPPORTED');
  assert.equal(inspectPlatformRequiredChecks('context-only-test', {
    cwd: process.cwd(),
    repository: 'acme/widgets',
    number: 7,
    headSha: 'a'.repeat(40)
  }).error?.code, 'PLATFORM_CAPABILITY_UNSUPPORTED');
});
