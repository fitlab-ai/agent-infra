import * as p from '@clack/prompts';
import type { SandboxConfig } from './config.ts';
import { sandboxLabel } from './constants.ts';
import { runEngine } from './shell.ts';

export function pruneSandboxDanglingImages(
  config: Pick<SandboxConfig, 'project'>,
  engine: string
): void {
  try {
    runEngine(engine, 'docker', [
      'image',
      'prune',
      '-f',
      '--filter',
      `label=${sandboxLabel(config)}`
    ]);
  } catch {
    p.log.warn(
      `Failed to prune dangling sandbox images (label=${sandboxLabel(config)}); leaving them in place.`
    );
  }
}
