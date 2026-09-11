import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MANUAL_VALIDATION_TASK_ID = /^TASK-\d{8}-\d{6}$/u;
const MANUAL_VALIDATION_SHA40 = /^[a-f0-9]{40}$/u;
const MANUAL_VALIDATION_SHA64 = /^[a-f0-9]{64}$/u;
const MANUAL_VALIDATION_ARTIFACT = /^manual-validation(?:-r[2-9]|-r[1-9]\d+)?.md$/u;
const MANUAL_VALIDATION_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): string | null {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) return `${label} contains unknown field '${unknown}'`;
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  return missing ? `${label} is missing '${missing}'` : null;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && MANUAL_VALIDATION_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function writeJsonAtomic(file: string, value: unknown): string {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort cleanup of our own temp file */ }
    throw error;
  }
  return file;
}

export {
  MANUAL_VALIDATION_ARTIFACT,
  MANUAL_VALIDATION_SHA40,
  MANUAL_VALIDATION_SHA64,
  MANUAL_VALIDATION_TASK_ID,
  MANUAL_VALIDATION_TIMESTAMP,
  exactKeys,
  isRecord,
  validTimestamp,
  writeJsonAtomic
};
