type CustomTUI = Readonly<{
  name: string;
  invocation: string;
}>;

type CustomTUIDiagnosticCode =
  | 'INVALID_CUSTOM_TUIS'
  | 'INVALID_CUSTOM_TUI'
  | 'INVALID_CUSTOM_TUI_PLACEHOLDER';

type CustomTUIDiagnostic = Readonly<{
  code: CustomTUIDiagnosticCode;
  path: string;
}>;

type NormalizeCustomTUIsResult = Readonly<{
  items: readonly CustomTUI[];
  diagnostics: readonly CustomTUIDiagnostic[];
}>;

const ALLOWED_PLACEHOLDERS = Object.freeze(['skillName', 'projectName']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptySingleLine(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim() !== ''
    && !/[\r\n]/.test(value);
}

function hasValidPlaceholders(invocation: string): boolean {
  const placeholders = [
    ...invocation.matchAll(/\$\{([^}]+)\}/g)
  ].map((match) => match[1]!);
  return placeholders.includes('skillName')
    && placeholders.every((placeholder) =>
      ALLOWED_PLACEHOLDERS.includes(placeholder)
    )
    && !invocation
      .replaceAll('${skillName}', '')
      .replaceAll('${projectName}', '')
      .includes('${');
}

function normalizeCustomTUIs(config: unknown): NormalizeCustomTUIsResult {
  const items: CustomTUI[] = [];
  const diagnostics: CustomTUIDiagnostic[] = [];

  const root = isRecord(config) ? config : {};
  const sandbox = isRecord(root.sandbox) ? root.sandbox : {};
  const sandboxTools = isRecord(sandbox.tools) ? sandbox.tools : { ids: ['agent-infra'] };
  const definitions = sandboxTools.definitions ?? {};
  const selectedIds = sandboxTools.ids;

  if (!Array.isArray(selectedIds)) {
    return Object.freeze({
      items: Object.freeze([]),
      diagnostics: Object.freeze([
        Object.freeze({
          code: 'INVALID_CUSTOM_TUIS' as const,
          path: 'sandbox.tools.ids'
        })
      ])
    });
  }

  if (!isRecord(definitions)) {
    return Object.freeze({
      items: Object.freeze([]),
      diagnostics: Object.freeze([
        Object.freeze({
          code: 'INVALID_CUSTOM_TUIS' as const,
          path: 'sandbox.tools.definitions'
        })
      ])
    });
  }

  for (const [index, id] of selectedIds.entries()) {
    if (typeof id !== 'string') {
      diagnostics.push({
        code: 'INVALID_CUSTOM_TUI',
        path: `sandbox.tools.ids[${index}]`
      });
      continue;
    }
    const candidate = definitions[id];
    if (!isRecord(candidate)) continue;
    if (candidate.invoke === undefined) continue;
    const base = `sandbox.tools.definitions.${id}`;
    const name = candidate.name === undefined ? id : candidate.name;
    if (!isNonEmptySingleLine(name)) {
      diagnostics.push({ code: 'INVALID_CUSTOM_TUI', path: `${base}.name` });
      continue;
    }
    if (!isNonEmptySingleLine(candidate.invoke)) {
      diagnostics.push({ code: 'INVALID_CUSTOM_TUI', path: `${base}.invoke` });
      continue;
    }
    if (!hasValidPlaceholders(candidate.invoke)) {
      diagnostics.push({
        code: 'INVALID_CUSTOM_TUI_PLACEHOLDER',
        path: `${base}.invoke`
      });
      continue;
    }
    items.push(Object.freeze({
      name,
      invocation: candidate.invoke
    }));
  }

  return Object.freeze({
    items: Object.freeze(items),
    diagnostics: Object.freeze(
      diagnostics.map((diagnostic) => Object.freeze(diagnostic))
    )
  });
}

export { normalizeCustomTUIs };
export type {
  CustomTUI,
  CustomTUIDiagnostic,
  CustomTUIDiagnosticCode,
  NormalizeCustomTUIsResult
};
