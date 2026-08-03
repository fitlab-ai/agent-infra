import type { AgentClientAdapter } from './adapter.ts';

type ProjectFileRegistry = Readonly<{
  managed: readonly string[];
  merged: readonly string[];
  ejected: readonly string[];
}>;

type AgentClientProjectAssetPlan = Readonly<{
  registry: ProjectFileRegistry;
  enabledManaged: readonly string[];
  enabledMerged: readonly string[];
  enabledEjected: readonly string[];
  disabledManaged: readonly string[];
}>;

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function planAgentClientProjectAssets(input: Readonly<{
  current: ProjectFileRegistry;
  sharedDefaults: ProjectFileRegistry;
  enabledAdapters: readonly AgentClientAdapter[];
  allAdapters: readonly AgentClientAdapter[];
  retiredAssets?: readonly string[];
}>): AgentClientProjectAssetPlan {
  const enabledIds = new Set(input.enabledAdapters.map((adapter) => adapter.id));
  const enabledAdapters = input.allAdapters.filter((adapter) =>
    enabledIds.has(adapter.id)
  );
  const disabledAdapters = input.allAdapters.filter((adapter) =>
    !enabledIds.has(adapter.id)
  );

  const enabledManaged = unique(
    enabledAdapters.flatMap((adapter) => adapter.project.managed)
  );
  const enabledMerged = unique(
    enabledAdapters.flatMap((adapter) => adapter.project.merged)
  );
  const enabledEjected = unique(
    enabledAdapters.flatMap((adapter) => adapter.project.ejected)
  );
  const disabledManaged = unique(
    disabledAdapters.flatMap((adapter) => adapter.project.managed)
  );

  const allAdapterAssets = new Set(
    [...input.allAdapters.flatMap((adapter) => [
      ...adapter.project.managed,
      ...adapter.project.merged,
      ...adapter.project.ejected
    ]), ...(input.retiredAssets ?? [])]
  );
  const ejected = unique([
    ...input.current.ejected,
    ...enabledEjected,
    ...input.sharedDefaults.ejected
  ]);
  const ejectedSet = new Set(ejected);

  const preserveCurrent = (
    values: readonly string[],
    enabledValues: readonly string[]
  ) => values.filter((entry) =>
    !ejectedSet.has(entry)
    && (!allAdapterAssets.has(entry) || enabledValues.includes(entry))
  );

  const managed = unique([
    ...preserveCurrent(input.current.managed, enabledManaged),
    ...enabledManaged.filter((entry) => !ejectedSet.has(entry)),
    ...input.sharedDefaults.managed.filter((entry) => !ejectedSet.has(entry))
  ]);
  const managedSet = new Set(managed);
  const merged = unique([
    ...preserveCurrent(input.current.merged, enabledMerged),
    ...enabledMerged.filter((entry) =>
      !ejectedSet.has(entry) && !managedSet.has(entry)
    ),
    ...input.sharedDefaults.merged.filter((entry) =>
      !ejectedSet.has(entry) && !managedSet.has(entry)
    )
  ]);

  return Object.freeze({
    registry: Object.freeze({ managed, merged, ejected }),
    enabledManaged,
    enabledMerged,
    enabledEjected,
    disabledManaged
  });
}

export { planAgentClientProjectAssets };
export type { AgentClientProjectAssetPlan, ProjectFileRegistry };
