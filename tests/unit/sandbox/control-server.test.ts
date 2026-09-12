import assert from 'node:assert/strict';
import test from 'node:test';

import { genericRecoveryResponse } from '../../../lib/sandbox/control/server.ts';
import type { SandboxControlRecoveryWarning, SandboxControlRequest } from '../../../lib/sandbox/control/protocol.ts';

test('server recovery response retains release retry warning when output payload is unavailable', () => {
  const request = {
    version: 3,
    id: 'a'.repeat(32),
    token: 'token',
    generation: 'generation-1',
    issuedAt: 1,
    expiresAt: 2,
    controllerProcess: null,
    controllerProof: null,
    family: 'task-lifecycle',
    args: ['TASK-20260904-002407', 'recover-started', '--agent', 'codex', '--stage', 'code', '--round', '1', '--artifact', 'code.md', '--reason', 'response loss']
  } as SandboxControlRequest;
  const warning: SandboxControlRecoveryWarning = {
    code: 'RECOVERY_RELEASE_RETRY_REQUIRED',
    message: 'protected claim could not be released',
    action: 'retry recover-started'
  };

  const response = genericRecoveryResponse(request, 0, null, 'recovery', warning);

  assert.equal(response.outputState, 'unavailable');
  assert.equal(response.stdout, '');
  assert.match(response.stderr, /RECOVERY_RELEASE_RETRY_REQUIRED/u);
  assert.match(response.stderr, /Action: retry recover-started/u);
});
