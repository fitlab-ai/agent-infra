import { createHash } from 'node:crypto';

const RECOVERY_SCHEMA_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;

type RecoveryActionInput = {
  taskId: string;
  actionId: string;
  sequence: number;
  type: string;
  payload: unknown;
  previousActionSha256: string | null;
};

type RecoveryAction = RecoveryActionInput & {
  schemaVersion: number;
  payloadSha256: string;
  actionSha256: string;
};

type RecoveryManifestInput = {
  taskId: string;
  commitId: string;
  phase: 'prepare' | 'commit';
  actionCount: number;
  actionHeadSha256: string;
  snapshotSha256: string;
};

type RecoveryManifest = RecoveryManifestInput & {
  schemaVersion: number;
  manifestSha256: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function validIdentity(value: string, name: string): void {
  if (!value || /[\r\n]/.test(value)) throw new Error(`${name} is invalid`);
}

function encodeRecoveryAction(input: RecoveryActionInput): RecoveryAction {
  validIdentity(input.taskId, 'taskId');
  validIdentity(input.actionId, 'actionId');
  validIdentity(input.type, 'type');
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error('sequence is invalid');
  if (input.previousActionSha256 !== null && !SHA256.test(input.previousActionSha256)) throw new Error('previousActionSha256 is invalid');
  const payloadSha256 = sha256(input.payload);
  const base = { ...input, schemaVersion: RECOVERY_SCHEMA_VERSION, payloadSha256 };
  return { ...base, actionSha256: sha256(base) };
}

function decodeRecoveryAction(value: unknown): RecoveryAction {
  if (!value || typeof value !== 'object') throw new Error('recovery action is invalid');
  const action = value as Partial<RecoveryAction>;
  if (action.schemaVersion !== RECOVERY_SCHEMA_VERSION || typeof action.payloadSha256 !== 'string' || typeof action.actionSha256 !== 'string') {
    throw new Error('recovery action schema is invalid');
  }
  const encoded = encodeRecoveryAction({
    taskId: String(action.taskId || ''), actionId: String(action.actionId || ''), sequence: Number(action.sequence),
    type: String(action.type || ''), payload: action.payload, previousActionSha256: action.previousActionSha256 === null ? null : String(action.previousActionSha256 || '')
  });
  if (encoded.payloadSha256 !== action.payloadSha256) throw new Error('recovery action payloadSha256 does not match payload');
  if (encoded.actionSha256 !== action.actionSha256) throw new Error('recovery action actionSha256 does not match content');
  return encoded;
}

function encodeRecoveryManifest(input: RecoveryManifestInput): RecoveryManifest {
  validIdentity(input.taskId, 'taskId');
  validIdentity(input.commitId, 'commitId');
  if (!['prepare', 'commit'].includes(input.phase)) throw new Error('manifest phase is invalid');
  if (!Number.isSafeInteger(input.actionCount) || input.actionCount < 0) throw new Error('actionCount is invalid');
  if (!SHA256.test(input.actionHeadSha256) || !SHA256.test(input.snapshotSha256)) throw new Error('manifest digest is invalid');
  const base = { ...input, schemaVersion: RECOVERY_SCHEMA_VERSION };
  return { ...base, manifestSha256: sha256(base) };
}

function decodeRecoveryManifest(value: unknown): RecoveryManifest {
  if (!value || typeof value !== 'object') throw new Error('recovery manifest is invalid');
  const manifest = value as Partial<RecoveryManifest>;
  if (manifest.schemaVersion !== RECOVERY_SCHEMA_VERSION || typeof manifest.manifestSha256 !== 'string') throw new Error('recovery manifest schema is invalid');
  const encoded = encodeRecoveryManifest({
    taskId: String(manifest.taskId || ''), commitId: String(manifest.commitId || ''), phase: manifest.phase as 'prepare' | 'commit',
    actionCount: Number(manifest.actionCount), actionHeadSha256: String(manifest.actionHeadSha256 || ''), snapshotSha256: String(manifest.snapshotSha256 || '')
  });
  if (encoded.manifestSha256 !== manifest.manifestSha256) throw new Error('recovery manifest manifestSha256 does not match content');
  return encoded;
}

export {
  RECOVERY_SCHEMA_VERSION,
  canonicalJson,
  encodeRecoveryAction,
  decodeRecoveryAction,
  encodeRecoveryManifest,
  decodeRecoveryManifest
};
export type { RecoveryAction, RecoveryActionInput, RecoveryManifest, RecoveryManifestInput };
