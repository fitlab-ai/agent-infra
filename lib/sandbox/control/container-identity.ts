import type { SandboxControlManifest } from './protocol.ts';
import { runProbe } from '../shell.ts';
import { captureSandboxAuthority, isSandboxAuthorityEvidence, verifySandboxAuthority } from '../engines/authority.ts';
import { discoverExactContainer } from '../engines/docker-exact-discovery.ts';

export type ContainerObservation =
  | Readonly<{ state: 'found'; id: string; running: boolean; labels: Readonly<Record<string, string>> }>
  | Readonly<{ state: 'absent'; id: string }>
  | Readonly<{ state: 'unknown'; reason: string }>;

export type ContainerInspection = Readonly<{
  id?: unknown;
  running?: unknown;
  labels?: unknown;
}>;

export function classifySandboxContainerInspection(
  expected: SandboxControlManifest['containerIdentity'],
  inspection: ContainerInspection | { notFound: true } | { error: unknown }
): ContainerObservation {
  if ('notFound' in inspection) return { state: 'absent', id: expected.id };
  if ('error' in inspection) {
    return { state: 'unknown', reason: `container inspection failed: ${inspection.error instanceof Error ? inspection.error.message : String(inspection.error)}` };
  }
  const response = inspection as ContainerInspection;
  if (typeof response.id !== 'string' || response.id !== expected.id
    || typeof response.running !== 'boolean' || !response.labels
    || typeof response.labels !== 'object' || Array.isArray(response.labels)) {
    return { state: 'unknown', reason: 'container inspection response is incomplete' };
  }
  const labels = response.labels as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected.labels)) {
    if (labels[key] !== value) return { state: 'unknown', reason: 'container labels do not match the manifest' };
  }
  return {
    state: 'found',
    id: response.id,
    running: response.running,
    labels: Object.fromEntries(
      Object.entries(labels).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : [])
    )
  };
}

export async function inspectSandboxControlContainer(
  manifest: SandboxControlManifest,
  options: { probe?: typeof runProbe; timeoutMs?: number } = {}
): Promise<ContainerObservation> {
  if (!isSandboxAuthorityEvidence(manifest.authorityEvidence)) {
    return { state: 'unknown', reason: 'SANDBOX_AUTHORITY_EVIDENCE_MISSING' };
  }
  try {
    const authority = captureSandboxAuthority(manifest.engine, {
      probe: options.probe,
      timeoutMs: options.timeoutMs,
      lockDomain: manifest.authorityEvidence.lockDomain
    });
    const authorityState = verifySandboxAuthority(manifest.authorityEvidence, authority);
    if (authorityState.state !== 'verified') {
      return { state: 'unknown', reason: authorityState.reason ?? 'SANDBOX_AUTHORITY_UNAVAILABLE' };
    }
    const discovered = discoverExactContainer(manifest.engine, manifest.containerIdentity.id, {
      probe: options.probe,
      timeoutMs: options.timeoutMs
    });
    if (discovered.state === 'absent') return { state: 'absent', id: discovered.id };
    if (discovered.state === 'conflict') {
      return { state: 'unknown', reason: `SANDBOX_CONTROL_CONTAINER_CONFLICT: ${discovered.reason}` };
    }
    if (discovered.state === 'unknown') return discovered;
    return classifySandboxContainerInspection(manifest.containerIdentity, discovered);
  } catch (error) {
    return classifySandboxContainerInspection(manifest.containerIdentity, { error });
  }
}
