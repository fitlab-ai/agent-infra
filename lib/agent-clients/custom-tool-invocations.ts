type CustomToolInvocation = Readonly<{
  name: string;
  invocation: string;
}>;

type CustomToolInvocationDiagnosticCode =
  | 'INVALID_CUSTOM_TOOL_CONFIG'
  | 'INVALID_CUSTOM_TOOL_INVOCATION'
  | 'INVALID_CUSTOM_TOOL_INVOCATION_PLACEHOLDER';

type CustomToolInvocationDiagnostic = Readonly<{
  code: CustomToolInvocationDiagnosticCode;
  path: string;
}>;

type NormalizeCustomToolInvocationsResult = Readonly<{
  items: readonly CustomToolInvocation[];
  diagnostics: readonly CustomToolInvocationDiagnostic[];
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

function normalizeCustomToolInvocations(config: unknown): NormalizeCustomToolInvocationsResult {
  const items: CustomToolInvocation[] = [];
  const diagnostics: CustomToolInvocationDiagnostic[] = [];

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
          code: 'INVALID_CUSTOM_TOOL_CONFIG' as const,
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
          code: 'INVALID_CUSTOM_TOOL_CONFIG' as const,
          path: 'sandbox.tools.definitions'
        })
      ])
    });
  }

  for (const [index, id] of selectedIds.entries()) {
    if (typeof id !== 'string') {
      diagnostics.push({
        code: 'INVALID_CUSTOM_TOOL_INVOCATION',
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
      diagnostics.push({ code: 'INVALID_CUSTOM_TOOL_INVOCATION', path: `${base}.name` });
      continue;
    }
    if (!isNonEmptySingleLine(candidate.invoke)) {
      diagnostics.push({ code: 'INVALID_CUSTOM_TOOL_INVOCATION', path: `${base}.invoke` });
      continue;
    }
    if (!hasValidPlaceholders(candidate.invoke)) {
      diagnostics.push({
        code: 'INVALID_CUSTOM_TOOL_INVOCATION_PLACEHOLDER',
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

export { normalizeCustomToolInvocations };
export type {
  CustomToolInvocation,
  CustomToolInvocationDiagnostic,
  CustomToolInvocationDiagnosticCode,
  NormalizeCustomToolInvocationsResult
};
