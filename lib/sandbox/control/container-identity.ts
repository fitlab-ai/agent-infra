import type { SandboxControlManifest } from './protocol.ts';
import { commandForEngine, runEngine, runProbe } from '../shell.ts';

export type ContainerObservation =
  | Readonly<{ state: 'found'; id: string; running: boolean; labels: Readonly<Record<string, string>> }>
  | Readonly<{ state: 'absent'; id: string }>
  | Readonly<{ state: 'unknown'; reason: string }>;

export type ContainerInspection = Readonly<{
  id?: unknown;
  running?: unknown;
  labels?: unknown;
}>;

function isAuthoritativeNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:no such (?:container|object)|container .* not found|cannot find container)/i.test(message);
}

export function classifySandboxContainerInspection(
  expected: SandboxControlManifest['containerIdentity'],
  inspection: ContainerInspection | { notFound: true } | { error: unknown }
): ContainerObservation {
  if ('notFound' in inspection) return { state: 'absent', id: expected.id };
  if ('error' in inspection) {
    return isAuthoritativeNotFound(inspection.error)
      ? { state: 'absent', id: expected.id }
      : { state: 'unknown', reason: `container inspection failed: ${inspection.error instanceof Error ? inspection.error.message : String(inspection.error)}` };
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
  options: { run?: typeof runEngine; probe?: typeof runProbe; timeoutMs?: number } = {}
): Promise<ContainerObservation> {
  try {
    const args = ['inspect', '--format', '{{json .}}', manifest.containerIdentity.id];
    let raw: string;
    if (options.run) {
      raw = options.run(manifest.engine, 'docker', args, options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs });
    } else {
      const command = commandForEngine(manifest.engine, 'docker', args);
      const result = (options.probe ?? runProbe)(
        command.cmd,
        command.args,
        options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }
      );
      if (result.status !== 0) {
        const stderr = typeof result.stderr === 'string' ? result.stderr : result.stderr?.toString('utf8') ?? '';
        return classifySandboxContainerInspection(manifest.containerIdentity, {
          error: new Error(stderr || `container inspection exited with ${result.status ?? 'unknown'}`)
        });
      }
      raw = typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf8') ?? '';
    }
    const parsed = JSON.parse(raw) as {
      Id?: unknown;
      State?: { Running?: unknown };
      Config?: { Labels?: unknown };
    } | Array<{
      Id?: unknown;
      State?: { Running?: unknown };
      Config?: { Labels?: unknown };
    }>;
    const value = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
    if (!value || Array.isArray(value)) return { state: 'unknown', reason: 'container inspection response is incomplete' };
    return classifySandboxContainerInspection(manifest.containerIdentity, {
      id: value.Id,
      running: value.State?.Running,
      labels: value.Config?.Labels
    });
  } catch (error) {
    return classifySandboxContainerInspection(manifest.containerIdentity, { error });
  }
}
