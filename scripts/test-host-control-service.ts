import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { dispatchHostControlCommand } from '../lib/host-control/command.ts';
import { startHostControlService } from '../lib/host-control/service.ts';

const readyPath = process.env.AGENT_INFRA_TEST_HOST_CONTROL_READY;
if (!readyPath) throw new Error('AGENT_INFRA_TEST_HOST_CONTROL_READY is required');

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const running = await startHostControlService({
  ...(process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT
    ? { endpoint: process.env.AGENT_INFRA_TEST_HOST_CONTROL_ENDPOINT }
    : {}),
  dispatch: async (request) => {
    if (request.scope !== 'host-command') throw new Error('HOST_CONTROL_SCOPE_UNSUPPORTED');
    return dispatchHostControlCommand(request);
  }
});

fs.writeFileSync(readyPath, `${fileURLToPath(import.meta.url)}\n`, { mode: 0o600 });
if (controller.signal.aborted) await running.close();
else await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => { void running.close().then(resolve); }, { once: true }));
