export interface CollectorPathPart {
  kind: string | null;
  name: string;
  siblingOrdinal: number;
}

export interface CollectedTest {
  path: CollectorPathPart[];
  kind: string | null;
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'todo';
  skip?: string | boolean;
  todo?: string | boolean;
  testNumber?: number;
}

export interface CollectorFile {
  file: string;
  tests: CollectedTest[];
  summaries: unknown[];
}

export interface CollectorResult {
  schemaVersion: number;
  valid: boolean;
  success?: boolean;
  errors: string[];
  files: CollectorFile[];
  aggregateSummary?: { success?: boolean };
}

export interface CollectorOptions {
  cwd?: string;
  mode?: 'source' | 'compiled';
  concurrency?: number | boolean;
  selections?: string[];
}

export interface Collector {
  handle(name: string, data: Record<string, unknown>): void;
  finish(): CollectorResult;
}

export function createCollector(options?: CollectorOptions): Collector;
export function collectTestEvents(options?: CollectorOptions): Promise<CollectorResult>;
