'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-infra-host-control-fixture-'));
const run = path.join(root, 'run');
const credential = path.join(root, 'fake-credential');
fs.mkdirSync(run, { recursive: true, mode: 0o700 });
fs.chmodSync(run, 0o700);
fs.writeFileSync(credential, 'fixture-only\n', { mode: 0o600, flag: 'wx' });
process.stdout.write(`${JSON.stringify({ root, endpoint: path.join(run, 'host-control.sock'), credential })}\n`);

const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
process.once('SIGINT', () => { cleanup(); process.exit(130); });
process.once('SIGTERM', () => { cleanup(); process.exit(143); });
process.once('exit', cleanup);
