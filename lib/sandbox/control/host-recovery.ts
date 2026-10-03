import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readSandboxControlManifest } from './lifecycle.ts';
import { identityDigest } from './identity-sentinel.ts';
import { readSandboxControlPayload, readSandboxControlResultEvidence } from './state.ts';
import { taskCreateOutputUnavailableResult } from '../../task/create-service.ts';
import type { SandboxControlManifest, SandboxControlResponse } from './protocol.ts';

const REQUEST_ID = /^[a-f0-9-]{16,64}$/u;

function unknown(requestId: string): SandboxControlResponse {
  return {
    version: 2, id: requestId, phase: 'rejected', exitCode: null, stdout: '', stderr: '',
    error: { code: 'SANDBOX_CONTROL_RESULT_UNKNOWN', message: 'SANDBOX_CONTROL_RESULT_UNKNOWN: recovery evidence is unavailable', retryable: false },
    outputState: 'unavailable', payload: null
  };
}

function manifestDigest(manifest: SandboxControlManifest): string {
  return identityDigest({
    version: 1, mode: manifest.mode, taskId: manifest.taskId,
    generation: manifest.generation, controlRootId: manifest.controlRootId
  });
}

function managedManifestPaths(managedRoot: string): string[] {
  if (!fs.existsSync(managedRoot)) return [];
  const rootStat = fs.lstatSync(managedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
  const result: string[] = [];
  for (const container of fs.readdirSync(managedRoot, { withFileTypes: true })) {
    if (!container.isDirectory() || container.isSymbolicLink()) continue;
    const containerPath = path.join(managedRoot, container.name);
    for (const identity of fs.readdirSync(containerPath, { withFileTypes: true })) {
      if (!identity.isDirectory() || identity.isSymbolicLink() || !/^[a-f0-9]{16}$/u.test(identity.name)) continue;
      result.push(path.join(containerPath, identity.name, 'manifest.json'));
    }
  }
  return result;
}

function assertDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
}

type AuditRecord = Record<string, unknown>;

function readAudit(manifest: SandboxControlManifest): AuditRecord[] {
  const root = path.dirname(path.resolve(manifest.publicStatusDir));
  const records: AuditRecord[] = [];
  for (const file of [path.join(root, 'audit.ndjson.1'), path.join(root, 'audit.ndjson')]) {
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_AUDIT_INVALID');
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new Error('SANDBOX_CONTROL_AUDIT_INVALID'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SANDBOX_CONTROL_AUDIT_INVALID');
      records.push(value as AuditRecord);
    }
  }
  return records;
}

function auditProof(manifest: SandboxControlManifest, requestId: string): AuditRecord[] {
  const digest = manifestDigest(manifest);
  const related = readAudit(manifest).filter((record) => record.requestId === requestId);
  for (const record of related) {
    if (record.generation !== manifest.generation || record.identityDigest !== digest) {
      throw new Error('SANDBOX_CONTROL_AUDIT_IDENTITY_MISMATCH');
    }
  }
  if (!related.some((record) => record.event === 'accepted-authorized'
    && record.version === 2 && record.phase === 'accepted-authorized')) return [];
  return related;
}

function publishedEvidence(records: AuditRecord[], generation: string): AuditRecord | null {
  const publications = records.filter((record) => record.event === 'executor-result-published');
  let selected: AuditRecord | null = null;
  let selectedSummary: string | null = null;
  for (const record of publications) {
    if (record.version !== 2 || record.requestGeneration !== generation
      || !Number.isSafeInteger(record.exitCode)
      || !Number.isSafeInteger(record.outputBytes) || !Number.isSafeInteger(record.errorBytes)
      || typeof record.outputDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.outputDigest)
      || typeof record.errorDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.errorDigest)) {
      throw new Error('SANDBOX_CONTROL_RESULT_EVIDENCE_INVALID');
    }
    const summary = JSON.stringify([
      record.requestFamily ?? null, record.requestGeneration, record.exitCode,
      record.outputBytes, record.errorBytes, record.outputDigest, record.errorDigest
    ]);
    if (selectedSummary !== null && summary !== selectedSummary) {
      throw new Error('SANDBOX_CONTROL_RESULT_EVIDENCE_CONFLICT');
    }
    selected ??= record;
    selectedSummary ??= summary;
  }
  return selected;
}

function verifiedResponse(manifest: SandboxControlManifest, requestId: string, records: AuditRecord[]): SandboxControlResponse | null {
  assertDirectory(manifest.channelDir);
  const responsesDir = path.join(manifest.channelDir, 'responses');
  assertDirectory(responsesDir);
  const responsePath = path.join(responsesDir, `${requestId}.json`);
  if (!fs.existsSync(responsePath)) return null;
  const responseStat = fs.lstatSync(responsePath);
  if (!responseStat.isFile() || responseStat.isSymbolicLink()) throw new Error('SANDBOX_CONTROL_RESPONSE_INVALID');
  const raw = fs.readFileSync(responsePath, 'utf8');
  let response: SandboxControlResponse;
  try { response = JSON.parse(raw) as SandboxControlResponse; } catch { throw new Error('SANDBOX_CONTROL_RESPONSE_INVALID'); }
  if (!response || response.version !== 2 || response.id !== requestId) throw new Error('SANDBOX_CONTROL_RESPONSE_INVALID');
  if (response.phase === 'accepted') return null;
  if (!['completed', 'rejected'].includes(response.phase)) throw new Error('SANDBOX_CONTROL_RESPONSE_INVALID');
  if (response.phase === 'rejected' && response.error?.code === 'SANDBOX_CONTROL_RESULT_UNKNOWN') return unknown(requestId);
  const evidencePath = path.join(manifest.processingDir, requestId, 'result.json');
  const published = publishedEvidence(records, manifest.generation);
  if (!published) return unknown(requestId);
  let evidence = null;
  if (fs.existsSync(evidencePath)) {
    evidence = readSandboxControlResultEvidence(evidencePath);
    if (evidence.id !== requestId || evidence.generation !== manifest.generation
      || evidence.exitCode !== published.exitCode || evidence.stdoutBytes !== published.outputBytes
      || evidence.stderrBytes !== published.errorBytes || evidence.stdoutSha256 !== published.outputDigest
      || evidence.stderrSha256 !== published.errorDigest) throw new Error('SANDBOX_CONTROL_RESULT_EVIDENCE_INVALID');
  }
  if (response.phase !== 'completed' || response.exitCode !== published.exitCode || response.error !== null) {
    throw new Error('SANDBOX_CONTROL_RESPONSE_INVALID');
  }
  if (response.outputState === undefined) {
    const stdout = response.stdout;
    const stderr = response.stderr;
    if (response.payload !== undefined
      || Buffer.byteLength(stdout, 'utf8') !== published.outputBytes
      || Buffer.byteLength(stderr, 'utf8') !== published.errorBytes
      || createHash('sha256').update(stdout, 'utf8').digest('hex') !== published.outputDigest
      || createHash('sha256').update(stderr, 'utf8').digest('hex') !== published.errorDigest) {
      throw new Error('SANDBOX_CONTROL_RESPONSE_INVALID');
    }
    return response;
  }
  if (response.outputState === 'available') {
    const payload = readSandboxControlPayload(path.join(manifest.channelDir, 'responses', `${requestId}.payload.json`));
    if (payload.id !== requestId || payload.generation !== manifest.generation
      || payload.stdoutBytes !== published.outputBytes || payload.stderrBytes !== published.errorBytes
      || payload.stdoutSha256 !== published.outputDigest || payload.stderrSha256 !== published.errorDigest
      || response.payload?.id !== payload.id || response.payload?.generation !== payload.generation
      || response.payload?.stdoutBytes !== payload.stdoutBytes || response.payload?.stderrBytes !== payload.stderrBytes
      || response.payload?.stdoutSha256 !== payload.stdoutSha256 || response.payload?.stderrSha256 !== payload.stderrSha256) {
      throw new Error('SANDBOX_CONTROL_RESPONSE_INVALID');
    }
    return { ...response, stdout: payload.stdout, stderr: payload.stderr };
  }
  const expectedStdout = published.requestFamily === 'task-create'
    ? `${JSON.stringify(taskCreateOutputUnavailableResult(requestId))}\n`
    : '';
  if (response.outputState !== 'unavailable' || response.payload !== null
    || response.stdout !== expectedStdout || response.stderr !== 'SANDBOX_CONTROL_OUTPUT_UNAVAILABLE: broker restarted after executor completion\n'
      && response.stderr !== 'SANDBOX_CONTROL_OUTPUT_UNAVAILABLE: output payload was not retained\n') {
    throw new Error('SANDBOX_CONTROL_RESPONSE_INVALID');
  }
  return response;
}

export function recoverSandboxControlFromHost(requestId: string, params: Readonly<{
  managedRoot: string; timeoutMs?: number;
}>): SandboxControlResponse {
  if (!REQUEST_ID.test(requestId)) throw new Error('SANDBOX_CONTROL_REQUEST_INVALID');
  const deadline = Date.now() + (params.timeoutMs ?? 30_000);
  let candidates: Array<{ manifest: SandboxControlManifest; records: AuditRecord[] }> = [];
  while (Date.now() < deadline) {
    candidates = [];
    for (const manifestPath of managedManifestPaths(params.managedRoot)) {
      let manifest: SandboxControlManifest;
      try { manifest = readSandboxControlManifest(manifestPath); } catch { throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID'); }
      if (manifest.project !== path.basename(path.resolve(params.managedRoot)) || !manifest.generation) {
        throw new Error('SANDBOX_CONTROL_MANIFEST_INVALID');
      }
      const records = auditProof(manifest, requestId);
      if (records.length) candidates.push({ manifest, records });
    }
    if (candidates.length > 1) throw new Error('SANDBOX_CONTROL_RECOVERY_AMBIGUOUS');
    if (candidates.length === 1) {
      const response = verifiedResponse(candidates[0]!.manifest, requestId, candidates[0]!.records);
      if (response) return response;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, remainingMs));
  }
  return unknown(requestId);
}
