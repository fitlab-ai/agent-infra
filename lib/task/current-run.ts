import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { AgentClientId } from '../agent-clients/types.ts';
import type { DelegationRole, DelegationStage } from './delegation-receipts.ts';

type CurrentRunState = 'starting' | 'running' | 'terminal';
type CurrentRun = Readonly<{
  taskId: string;
  runId: string;
  mode: 'orchestrated';
  stage: DelegationStage;
  round: number;
  artifact: string;
  role: DelegationRole;
  client: AgentClientId;
  state: CurrentRunState;
  startedAt: string;
  lastObservedAt: string;
  spawnAttemptId: string;
  childId: string | null;
  terminalOutcome: 'completed' | 'failed' | 'not-started' | null;
  terminalAt: string | null;
}>;
type CurrentRunDiscovery = Readonly<{
  status: 'running' | 'terminal' | 'not-started' | 'unknown' | 'ambiguous';
  childId?: string;
}>;

function currentRunPath(taskDir: string): string {
  return path.join(taskDir, 'current-run.json');
}

function exactText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isCurrentRun(value: unknown, taskId: string): value is CurrentRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(',') === [
    'artifact', 'childId', 'client', 'lastObservedAt', 'mode', 'role', 'round', 'runId',
    'spawnAttemptId', 'stage', 'startedAt', 'state', 'taskId', 'terminalAt', 'terminalOutcome'
  ].join(',')
    && record.taskId === taskId
    && exactText(record.runId)
    && record.mode === 'orchestrated'
    && typeof record.stage === 'string'
    && Number.isSafeInteger(record.round) && (record.round as number) > 0
    && exactText(record.artifact)
    && (record.role === 'executor' || record.role === 'reviewer')
    && typeof record.client === 'string'
    && ['starting', 'running', 'terminal'].includes(record.state as string)
    && exactText(record.startedAt)
    && exactText(record.lastObservedAt)
    && exactText(record.spawnAttemptId)
    && (record.childId === null || exactText(record.childId))
    && (record.terminalOutcome === null || ['completed', 'failed', 'not-started'].includes(record.terminalOutcome as string))
    && (record.terminalAt === null || exactText(record.terminalAt));
}

function readCurrentRun(taskDir: string): CurrentRun | null {
  const file = currentRunPath(taskDir);
  if (!fs.existsSync(file)) return null;
  const taskId = path.basename(taskDir);
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isCurrentRun(value, taskId)) throw new Error('CURRENT_RUN_INVALID');
  return value;
}

function writeCurrentRun(taskDir: string, run: CurrentRun): void {
  const file = currentRunPath(taskDir);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporary, file);
}

function startCurrentRun(taskDir: string, input: Omit<CurrentRun, 'state' | 'childId' | 'terminalOutcome' | 'terminalAt'>): CurrentRun {
  const run: CurrentRun = {
    ...input,
    state: 'starting',
    childId: null,
    terminalOutcome: null,
    terminalAt: null
  };
  writeCurrentRun(taskDir, run);
  return run;
}

function observeCurrentRun(taskDir: string, run: CurrentRun, discovery: CurrentRunDiscovery, observedAt: string): CurrentRun {
  let next: CurrentRun;
  if (discovery.status === 'running' && discovery.childId) {
    next = { ...run, state: 'running', childId: discovery.childId, lastObservedAt: observedAt };
  } else if (discovery.status === 'terminal' || discovery.status === 'not-started') {
    next = {
      ...run,
      state: 'terminal',
      lastObservedAt: observedAt,
      terminalOutcome: discovery.status === 'terminal' ? 'completed' : 'not-started',
      terminalAt: observedAt
    };
  } else {
    next = { ...run, lastObservedAt: observedAt };
  }
  writeCurrentRun(taskDir, next);
  return next;
}

function reconcileCurrentRun(
  taskDir: string,
  discover: (run: CurrentRun) => CurrentRunDiscovery,
  observedAt: string
): CurrentRun | null {
  const run = readCurrentRun(taskDir);
  return run ? observeCurrentRun(taskDir, run, discover(run), observedAt) : null;
}

export { currentRunPath, observeCurrentRun, readCurrentRun, reconcileCurrentRun, startCurrentRun, writeCurrentRun };
export type { CurrentRun, CurrentRunDiscovery, CurrentRunState };
