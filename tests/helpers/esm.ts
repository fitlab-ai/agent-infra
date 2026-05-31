import { pathToFileURL } from "node:url";
import { filePath } from "./paths.ts";

type RegistryEntry = {
  entry: string;
  list?: string;
};
type SyncTemplatesReport = {
  templateRoot: string;
  templateVersion: string;
  configUpdated: boolean;
  templateSources: {
    configured: number;
    loaded: number;
    files: number;
    errors: Array<Record<string, unknown>>;
    conflicts: Array<Record<string, unknown>>;
  };
  registryAdded: RegistryEntry[];
  managed: {
    created: string[];
    removed: string[];
    written: string[];
    unchanged: string[];
    skippedMerged: string[];
  };
  merged: {
    pending: Array<{ target: string }>;
  };
  ejected: {
    preserved: string[];
    missing: string[];
    created: string[];
    skipped: string[];
  };
  custom: {
    detected: string[];
    generated: string[];
    removed: string[];
    sourceErrors: Array<Record<string, unknown>>;
    commands: {
      generated: string[];
      updated: string[];
      unchanged: string[];
    };
    customTUIs: {
      skipped: string[];
      skippedRefs: string[];
    };
  };
};
type SyncTemplatesModule = {
  syncTemplates(projectRoot: string, templateRootOverride?: string): SyncTemplatesReport;
};
type PlatformSyncModule = {
  getDefaults(): {
    statusLabels: {
      inProgress: string;
      pendingDesignWork: string;
      waitingForTriage: string;
    };
    markers: Record<string, string>;
    labels: {
      status: string[];
      type: string[];
      priority: string[];
      area: string[];
      special: string[];
    };
    milestones: Array<Record<string, unknown>>;
  };
  check(context: unknown, shared: unknown): unknown;
};

async function loadFreshEsm<T = Record<string, unknown>>(relativePath: string): Promise<T> {
  const moduleUrl = pathToFileURL(filePath(relativePath));
  moduleUrl.searchParams.set("v", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return import(moduleUrl.href) as Promise<T>;
}

export {
  loadFreshEsm
};

export type {
  PlatformSyncModule,
  SyncTemplatesModule,
  SyncTemplatesReport
};
