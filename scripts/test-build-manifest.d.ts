export interface TestBuildInput {
  source: string;
  sourceSha256: string;
  output: string | null;
  outputSha256: string | null;
}

export interface TestBuildManifest {
  version: number;
  projectRoot: string;
  inputs: TestBuildInput[];
}

export type ManifestValidation =
  | { ok: true; manifest: TestBuildManifest }
  | { ok: false; message: string };

export const MANIFEST_RELATIVE_PATH: string;
export function buildManifest(projectRoot: string): TestBuildManifest;
export function manifestPath(projectRoot: string): string;
export function validateManifest(projectRoot: string): ManifestValidation;
export function writeManifest(projectRoot: string): TestBuildManifest;
