const TYPE_LABELS: Record<string, string> = {
  bug: 'type: bug',
  bugfix: 'type: bug',
  feature: 'type: feature',
  enhancement: 'type: enhancement',
  refactor: 'type: enhancement',
  refactoring: 'type: enhancement',
  documentation: 'type: documentation',
  docs: 'type: documentation',
  'dependency-upgrade': 'type: dependency-upgrade',
  task: 'type: task',
  chore: 'type: task'
};

function taskTypeLabel(taskType: string): string | null {
  return TYPE_LABELS[taskType] || null;
}

function computeInLabels(
  changedFiles: string[],
  mapping: Record<string, unknown>,
  repositoryLabels: Set<string>
): string[] {
  return Object.entries(mapping).flatMap(([name, rawPrefixes]) => {
    if (!Array.isArray(rawPrefixes)) return [];
    const matches = rawPrefixes.some((prefix) => typeof prefix === 'string' && prefix.length > 0
      && changedFiles.some((file) => file === prefix.replace(/\/$/, '') || file.startsWith(prefix)));
    const label = `in: ${name}`;
    return matches && repositoryLabels.has(label) ? [label] : [];
  }).sort();
}

export { computeInLabels, taskTypeLabel };
