import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { lintContract } from './eslint.config.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TOOL_DIR, '../..');
const BASELINE_PATH = path.join(TOOL_DIR, 'baseline.json');
const RULES = Object.fromEntries(Object.keys(lintContract.rules).map((ruleId) => [ruleId, lintContract.rules[ruleId][1]]));
const SCOPE = lintContract.scanFiles;
const require = createRequire(import.meta.url);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const stableJson = (value) => JSON.stringify(sortObjectKeys(value), (_key, item) =>
  typeof item === 'bigint' ? { $bigint: item.toString() } : item
);

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObjectKeys(value[key])]));
  }
  return value;
}

function packageVersion(name) {
  let current = path.dirname(require.resolve(name));
  while (current !== path.dirname(current)) {
    try {
      const candidate = JSON.parse(readFileSync(path.join(current, 'package.json'), 'utf8'));
      if (candidate.name === name) return candidate.version;
    } catch {
      // Continue walking until the package root is found.
    }
    current = path.dirname(current);
  }
  throw new Error(`Cannot locate package metadata for ${name}`);
}

export function metadata() {
  const toolchain = {
    eslint: packageVersion('eslint'),
    typescriptEslint: packageVersion('typescript-eslint'),
    typescript: packageVersion('typescript')
  };
  return {
    schemaVersion: 2,
    toolchain,
    configDigest: sha256(stableJson({
      eslintConfig: sha256(readFileSync(path.join(TOOL_DIR, 'eslint.config.mjs'))),
      parser: toolchain.typescriptEslint
    })),
    scopeDigest: sha256(stableJson({ files: SCOPE, ignores: lintContract.ignores, eslintFiles: lintContract.files }))
  };
}

function lineColumnToOffset(source, line, column) {
  let offset = 0;
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const next = source.indexOf('\n', offset);
    if (next < 0) return source.length;
    offset = next + 1;
  }
  return Math.min(source.length, offset + column - 1);
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const REMOVED_AST_KEYS = new Set([
  'parent', 'loc', 'range', 'start', 'end', 'tokens', 'comments', 'leadingComments', 'trailingComments'
]);

function astForSource(source, filePath) {
  const parsed = tseslint.parser.parseForESLint(source, {
    filePath,
    sourceType: 'module',
    ecmaVersion: 'latest',
    loc: true,
    range: true,
    tokens: false,
    comment: false
  });
  return parsed;
}

function findAnchor(parsed, source, line, column) {
  const offset = lineColumnToOffset(source, line, column);
  const functions = [];
  const propertyValues = [];
  const unsupportedPropertyHeaders = [];
  const statements = [];
  const { ast, visitorKeys } = parsed;

  function visit(node) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    const containsOffset = Array.isArray(node.range) && node.range[0] <= offset && node.range[1] >= offset;
    if (containsOffset && FUNCTION_TYPES.has(node.type)) functions.push(node);
    if (containsOffset && node.type === 'MethodDefinition' && FUNCTION_TYPES.has(node.value?.type)) functions.push(node.value);
    if (containsOffset && ['Property', 'PropertyDefinition'].includes(node.type)
      && node.range[0] <= offset && offset < (node.value?.range?.[0] ?? node.range[1])) {
      if (FUNCTION_TYPES.has(node.value?.type)) propertyValues.push({ property: node, value: node.value });
      else unsupportedPropertyHeaders.push(node);
    }
    if (containsOffset && node.type.endsWith('Statement')) statements.push(node);
    for (const key of visitorKeys[node.type] ?? []) {
      const children = node[key];
      if (Array.isArray(children)) children.forEach(visit);
      else visit(children);
    }
  }

  visit(ast);
  functions.sort((left, right) => (left.range[1] - left.range[0]) - (right.range[1] - right.range[0]));
  const headerFunctions = functions.filter((fn) => propertyValues.some(({ property, value }) =>
    fn !== value && fn.range[0] >= property.range[0] && fn.range[1] <= value.range[0]));
  if (headerFunctions[0]) return headerFunctions[0];
  if (propertyValues.length > 0) {
    propertyValues.sort((left, right) =>
      (left.property.range[1] - left.property.range[0]) - (right.property.range[1] - right.property.range[0]));
    return propertyValues[0].value;
  }
  if (functions[0]) return functions[0];
  if (unsupportedPropertyHeaders.length > 0) {
    const property = unsupportedPropertyHeaders[0];
    throw new Error(`Cannot associate diagnostic at ${property.type} header with a function value`);
  }
  statements.sort((left, right) => (left.range[1] - left.range[0]) - (right.range[1] - right.range[0]));
  return statements[0] ?? ast;
}

function canonicalAst(value) {
  if (Array.isArray(value)) return value.map(canonicalAst);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!REMOVED_AST_KEYS.has(key)) result[key] = canonicalAst(value[key]);
  }
  return result;
}

function parseMetric(ruleId, message) {
  if (ruleId === 'complexity') {
    const match = /complexity of (\d+)/i.exec(message);
    if (match) return { metric: Number(match[1]), normalizedMessage: `complexity=${match[1]}` };
  }
  if (ruleId === 'max-depth') {
    const match = /nested too deeply \((\d+)\)/i.exec(message);
    if (match) return { metric: Number(match[1]), normalizedMessage: `depth=${match[1]}` };
  }
  throw new Error(`Unrecognized ${ruleId} diagnostic: ${message}`);
}

function normalizeMetricMessage(ruleId, metric) {
  if (ruleId === 'complexity') return `complexity=${metric}`;
  if (ruleId === 'max-depth') return `depth=${metric}`;
  throw new Error(`Unrecognized metric rule: ${ruleId}`);
}

function parentIndex(parsed) {
  const parents = new WeakMap();
  const nodes = [];
  const nodesByType = new Map();
  function visit(node, parent = null) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    parents.set(node, parent);
    nodes.push(node);
    const typedNodes = nodesByType.get(node.type) ?? [];
    typedNodes.push(node);
    nodesByType.set(node.type, typedNodes);
    for (const key of parsed.visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach((item) => visit(item, node));
      else visit(child, node);
    }
  }
  visit(parsed.ast);
  return { parents, nodes, nodesByType };
}

function nodesOfType(indices, type) {
  return indices.nodesByType.get(type) ?? [];
}

function propertyName(node, source) {
  if (!node) return '<unknown>';
  if (!node.computed && node.type === 'Identifier') return node.name;
  if (node.type === 'PrivateIdentifier') return `#${node.name}`;
  if (node.type === 'Literal') return String(node.value);
  return `[${sha256(stableJson(canonicalAst(node))).slice(0, 12)}:${source.slice(node.range[0], node.range[1]).replace(/\s+/g, ' ').trim()}]`;
}

function propertyFunctionRole(parent, source) {
  const name = propertyName(parent.key, source);
  if (parent.type === 'PropertyDefinition') return `property:${parent.static ? 'static' : 'instance'}:${name}`;
  const role = parent.kind === 'get' || parent.kind === 'set'
    ? parent.kind
    : parent.method ? 'method' : 'value';
  return `property:${role}:${name}`;
}

function canonicalCalleeAst(value) {
  if (Array.isArray(value)) return value.map(canonicalCalleeAst);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (REMOVED_AST_KEYS.has(key) || (FUNCTION_TYPES.has(value.type) && key === 'body')) continue;
    result[key] = canonicalCalleeAst(value[key]);
  }
  return result;
}

function enclosingOwner(node, parents) {
  for (let current = parents.get(node); current; current = parents.get(current)) {
    if (FUNCTION_TYPES.has(current.type) || current.type === 'ClassDeclaration' || current.type === 'ClassExpression' ||
      current.type === 'ObjectExpression' || current.type === 'TSModuleDeclaration' || current.type === 'Program') return current;
  }
  return null;
}

function callCallee(call, source) {
  const callee = call.callee;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed) {
    return `${callCallee({ callee: callee.object }, source)}.${propertyName(callee.property, source)}`;
  }
  return `${callee.type}:${sha256(stableJson(canonicalCalleeAst(callee))).slice(0, 12)}`;
}

function callbackRole(target, parent, owner, source, indices) {
  const argumentIndex = parent.arguments.indexOf(target);
  const callee = callCallee(parent, source);
  const siblingOrdinal = nodesOfType(indices, 'CallExpression').filter((node) =>
    callCallee(node, source) === callee && node.arguments[argumentIndex] &&
    FUNCTION_TYPES.has(node.arguments[argumentIndex].type) &&
    enclosingOwner(node, indices.parents) === owner).indexOf(parent) + 1;
  if (!siblingOrdinal) throw new Error(`Cannot establish a sibling ordinal for anonymous callback ${callee}[${argumentIndex}]`);
  return `callback:${callee}:argument:${argumentIndex}:sibling:${siblingOrdinal}`;
}

function functionExpressionRole(target, parent, owner, source, indices) {
  if (parent?.type === 'VariableDeclarator' && parent.init === target) return `binding:${propertyName(parent.id, source)}`;
  if ((parent?.type === 'PropertyDefinition' || parent?.type === 'Property') && parent.value === target) {
    return propertyFunctionRole(parent, source);
  }
  if (parent?.type === 'AssignmentExpression' && parent.right === target) {
    return `assignment:${sha256(stableJson(canonicalAst(parent.left))).slice(0, 16)}`;
  }
  if (parent?.type === 'CallExpression' && parent.arguments.includes(target)) {
    return callbackRole(target, parent, owner, source, indices);
  }
  const parentType = parent?.type ?? 'Program';
  const siblingOrdinal = nodesOfType(indices, 'FunctionExpression').filter((node) => node.id?.name === target.id?.name &&
    indices.parents.get(node)?.type === parentType && enclosingOwner(node, indices.parents) === owner).indexOf(target) + 1;
  if (!siblingOrdinal) throw new Error(`Cannot establish a stable binding role for named FunctionExpression ${target.id?.name ?? '<unknown>'}`);
  return `parent:${parentType}:sibling:${siblingOrdinal}`;
}

function classExpressionRole(owner, parent, outer, source, indices) {
  if (parent?.type === 'VariableDeclarator' && parent.init === owner) return `binding:${propertyName(parent.id, source)}`;
  if ((parent?.type === 'PropertyDefinition' || parent?.type === 'Property') && parent.value === owner) {
    return `property:${propertyName(parent.key, source)}`;
  }
  if (parent?.type === 'AssignmentExpression' && parent.right === owner) {
    return `assignment:${sha256(stableJson(canonicalAst(parent.left))).slice(0, 16)}`;
  }
  if (parent?.type === 'CallExpression' && parent.arguments.includes(owner)) {
    const argumentIndex = parent.arguments.indexOf(owner);
    const callee = callCallee(parent, source);
    const siblingOrdinal = nodesOfType(indices, 'CallExpression').filter((node) =>
      callCallee(node, source) === callee && node.arguments[argumentIndex]?.type === 'ClassExpression' &&
      enclosingOwner(node, indices.parents) === outer).indexOf(parent) + 1;
    if (!siblingOrdinal) throw new Error(`Cannot establish a lexical role for class expression passed to ${callee}`);
    return `argument:${callee}:${argumentIndex}:sibling:${siblingOrdinal}`;
  }
  const parentType = parent?.type ?? 'Program';
  const siblingOrdinal = nodesOfType(indices, 'ClassExpression').filter((node) =>
    indices.parents.get(node)?.type === parentType && enclosingOwner(node, indices.parents) === outer).indexOf(owner) + 1;
  if (!siblingOrdinal) throw new Error(`Cannot establish a stable lexical owner for anonymous class expression in ${parentType}`);
  return `anonymous:${parentType}:sibling:${siblingOrdinal}`;
}

function descriptorForFunction(target, parsed, source, indices, cache, visiting = new Set()) {
  if (cache.has(target)) return cache.get(target);
  if (visiting.has(target)) throw new Error('Cannot establish a non-cyclic stable method identity');
  visiting.add(target);
  const { parents, nodes } = indices;
  const parent = parents.get(target);
  let segment;
  let display;

  if (parent?.type === 'MethodDefinition' && parent.value === target) {
    const name = propertyName(parent.key, source);
    const owner = enclosingOwner(parent, parents);
    const ownerDescriptor = owner && owner !== parsed.ast ? descriptorForOwner(owner, parsed, source, indices, cache, visiting) : 'module';
    segment = `method:${target.type}:${parent.kind}:${parent.static ? 'static:' : ''}${name}`;
    display = `${ownerDescriptor.displayName}.${name}`;
  } else if (target.type === 'FunctionDeclaration' && target.id) {
    segment = `function:${target.type}:${target.id.name}`;
    const owner = enclosingOwner(target, parents);
    const ownerDescriptor = owner && owner !== parsed.ast ? descriptorForOwner(owner, parsed, source, indices, cache, visiting) : null;
    display = ownerDescriptor ? `${ownerDescriptor.displayName}.${target.id.name}` : target.id.name;
  } else if (target.type === 'FunctionExpression' && target.id) {
    const owner = enclosingOwner(target, parents);
    const ownerDescriptor = owner && owner !== parsed.ast ? descriptorForOwner(owner, parsed, source, indices, cache, visiting) : null;
    const sameNameInOwner = nodesOfType(indices, 'FunctionExpression').filter((node) => node.id?.name === target.id.name &&
      enclosingOwner(node, parents) === owner);
    if (sameNameInOwner.length > 1) {
      const role = functionExpressionRole(target, parent, owner, source, indices);
      segment = `named-expression:${target.type}:${role}:name:${target.id.name}`;
      const roleDisplay = role.startsWith('binding:') || role.startsWith('property:') ? role.slice(role.indexOf(':') + 1) : target.id.name;
      display = `${ownerDescriptor?.displayName ? `${ownerDescriptor.displayName}.` : ''}${roleDisplay}${roleDisplay === target.id.name ? '' : ` (${target.id.name})`}`;
    } else {
      segment = `named-expression:${target.type}:${target.id.name}`;
      display = ownerDescriptor ? `${ownerDescriptor.displayName}.${target.id.name}` : target.id.name;
    }
  } else {
    let binding;
    let context = parent;
    if (parent?.type === 'VariableDeclarator' && parent.init === target) {
      binding = `binding:${propertyName(parent.id, source)}`;
      context = parent;
    } else if ((parent?.type === 'PropertyDefinition' || parent?.type === 'Property') && parent.value === target) {
      binding = propertyFunctionRole(parent, source);
      context = parent;
    } else if (parent?.type === 'AssignmentExpression' && parent.right === target) {
      binding = `assignment:${sha256(stableJson(canonicalAst(parent.left))).slice(0, 16)}`;
      context = parent;
    }
    const owner = enclosingOwner(context ?? target, parents);
    const ownerDescriptor = owner && owner !== parsed.ast ? descriptorForOwner(owner, parsed, source, indices, cache, visiting) : null;
    if (binding) {
      segment = binding;
      display = `${ownerDescriptor ? `${ownerDescriptor.displayName}.` : ''}${binding.slice(binding.indexOf(':') + 1)}`;
    } else if (parent?.type === 'CallExpression' && parent.arguments.includes(target)) {
      segment = callbackRole(target, parent, owner, source, indices);
      const argumentIndex = parent.arguments.indexOf(target);
      const callee = callCallee(parent, source);
      const siblingOrdinal = segment.slice(segment.lastIndexOf(':') + 1);
      display = `${ownerDescriptor ? `${ownerDescriptor.displayName}.` : ''}${callee} callback[${argumentIndex}]#${siblingOrdinal}`;
    } else {
      const parentType = parent?.type ?? 'Program';
      const siblings = nodes.filter((node) => FUNCTION_TYPES.has(node.type) &&
        parents.get(node)?.type === parentType && node.type === target.type &&
        enclosingOwner(node, parents) === owner);
      const siblingOrdinal = siblings.indexOf(target) + 1;
      if (!siblingOrdinal) throw new Error(`Cannot establish a stable identity for anonymous ${target.type}`);
      segment = `anonymous:${target.type}:${parentType}:sibling:${siblingOrdinal}`;
      display = `${ownerDescriptor ? `${ownerDescriptor.displayName}.` : ''}<anonymous ${target.type}#${siblingOrdinal}>`;
    }
  }

  const owner = enclosingOwner(target, parents);
  let identityPath = [];
  if (owner && owner !== parsed.ast) identityPath = descriptorForOwner(owner, parsed, source, indices, cache, visiting).identityPath;
  const descriptor = { identityPath: [...identityPath, segment], displayName: display };
  cache.set(target, descriptor);
  visiting.delete(target);
  return descriptor;
}

function descriptorForOwner(owner, parsed, source, indices, cache, visiting) {
  if (owner.type === 'Program') return { identityPath: [], displayName: '' };
  if (FUNCTION_TYPES.has(owner.type)) return descriptorForFunction(owner, parsed, source, indices, cache, visiting);
  if (owner.type === 'ClassDeclaration' || owner.type === 'ClassExpression') {
    const parent = indices.parents.get(owner);
    const outer = enclosingOwner(owner, indices.parents);
    const outerDescriptor = outer && outer !== parsed.ast ? descriptorForOwner(outer, parsed, source, indices, cache, visiting) : { identityPath: [], displayName: '' };
    const classRole = owner.type === 'ClassDeclaration'
      ? `declaration:${owner.id?.name ?? '<anonymous-class>'}`
      : classExpressionRole(owner, parent, outer, source, indices);
    const bindingName = classRole.startsWith('binding:') ? classRole.slice('binding:'.length) : null;
    const className = owner.id?.name ?? bindingName ?? `<anonymous-class ${classRole}>`;
    let classIdentity;
    if (owner.type === 'ClassDeclaration') {
      classIdentity = `class:${className}`;
    } else if (owner.id?.name) {
      const sameNameInOwner = nodesOfType(indices, 'ClassExpression').filter((node) => node.id?.name === owner.id.name &&
        enclosingOwner(node, indices.parents) === outer);
      classIdentity = sameNameInOwner.length > 1 ? `class:${classRole}:name:${owner.id.name}` : `class:${owner.id.name}`;
    } else if (classRole.startsWith('binding:')) {
      classIdentity = `class:${bindingName}`;
    } else {
      classIdentity = `class:${classRole}`;
    }
    const descriptor = {
      identityPath: [...outerDescriptor.identityPath, classIdentity],
      displayName: `${outerDescriptor.displayName ? `${outerDescriptor.displayName}.` : ''}${className}`
    };
    cache.set(owner, descriptor);
    return descriptor;
  }
  if (owner.type === 'TSModuleDeclaration') {
    const outer = enclosingOwner(owner, indices.parents);
    const outerDescriptor = outer && outer !== parsed.ast ? descriptorForOwner(outer, parsed, source, indices, cache, visiting) : { identityPath: [], displayName: '' };
    const name = propertyName(owner.id, source);
    const descriptor = {
      identityPath: [...outerDescriptor.identityPath, `module:${name}`],
      displayName: `${outerDescriptor.displayName ? `${outerDescriptor.displayName}.` : ''}${name}`
    };
    cache.set(owner, descriptor);
    return descriptor;
  }
  if (owner.type === 'ObjectExpression') {
    const parent = indices.parents.get(owner);
    const outer = enclosingOwner(owner, indices.parents);
    const outerDescriptor = outer && outer !== parsed.ast ? descriptorForOwner(outer, parsed, source, indices, cache, visiting) : { identityPath: [], displayName: '' };
    let name;
    if (parent?.type === 'VariableDeclarator') name = propertyName(parent.id, source);
    else if (parent?.type === 'Property') name = propertyName(parent.key, source);
    else if (parent?.type === 'AssignmentExpression') name = `assignment-${sha256(stableJson(canonicalAst(parent.left))).slice(0, 12)}`;
    else {
      const siblingOrdinal = nodesOfType(indices, 'ObjectExpression').filter((node) =>
        indices.parents.get(node)?.type === parent?.type && enclosingOwner(node, indices.parents) === outer).indexOf(owner) + 1;
      if (!siblingOrdinal) throw new Error('Cannot establish a stable lexical owner for anonymous object methods');
      name = `anonymous-object-${siblingOrdinal}`;
    }
    const descriptor = {
      identityPath: [...outerDescriptor.identityPath, `object:${name}`],
      displayName: `${outerDescriptor.displayName ? `${outerDescriptor.displayName}.` : ''}${name}`
    };
    cache.set(owner, descriptor);
    return descriptor;
  }
  return { identityPath: [], displayName: '' };
}

function createFileAnalysis(source, filePath) {
  const parsed = astForSource(source, filePath);
  return {
    parsed,
    source,
    indices: parentIndex(parsed),
    descriptors: new Map(),
    collisionCandidates: null
  };
}

function collisionCandidatesFor(analysis, target, targetDescriptor) {
  if (analysis.collisionCandidates) return analysis.collisionCandidates;
  const { parsed, source, indices, descriptors } = analysis;
  const candidates = new Map();
  const add = (node, descriptor) => {
    const identity = stableJson(descriptor.identityPath);
    const group = candidates.get(identity) ?? [];
    group.push({ node, descriptor });
    candidates.set(identity, group);
  };
  add(target, targetDescriptor);
  for (const node of indices.nodes) {
    if (!FUNCTION_TYPES.has(node.type) || node === target) continue;
    add(node, descriptorForFunction(node, parsed, source, indices, descriptors));
  }
  analysis.collisionCandidates = candidates;
  return candidates;
}

function assertNoIdentityCollisions(analysis, target, targetDescriptor, filePath, ruleId) {
  const { indices } = analysis;
  const candidates = collisionCandidatesFor(analysis, target, targetDescriptor)
    .get(stableJson(targetDescriptor.identityPath)) ?? [];
  for (const { node } of candidates) {
    if (node === target) continue;
    const parent = indices.parents.get(node);
    const targetParent = indices.parents.get(target);
    const overloadPair = parent?.type === 'MethodDefinition' && targetParent?.type === 'MethodDefinition' &&
      parent.key.name === targetParent.key.name &&
      (node.body == null || target.body == null);
    if (!overloadPair) throw new Error(`Stable method identity collision: ${filePath} ${ruleId} ${targetDescriptor.displayName}`);
  }
}

function violationEntryWithAnalysis({ filePath, message, source }, analysis) {
  const relativePath = path.relative(ROOT_DIR, filePath).split(path.sep).join('/');
  const { parsed, indices, descriptors } = analysis;
  const anchor = findAnchor(parsed, source, message.line, message.column);
  const { metric, normalizedMessage } = parseMetric(message.ruleId, message.message);
  let descriptor;
  try {
    descriptor = descriptorForFunction(anchor, parsed, source, indices, descriptors);
    assertNoIdentityCollisions(analysis, anchor, descriptor, relativePath, message.ruleId);
  } catch (error) {
    throw new Error(`${relativePath} ${message.ruleId}: ${error.message}`, { cause: error });
  }
  const stableId = sha256(stableJson({ file: relativePath, identityPath: descriptor.identityPath }));
  return {
    file: relativePath,
    ruleId: message.ruleId,
    stableId,
    displayName: descriptor.displayName,
    metric,
    normalizedMessage
  };
}

export function violationEntry(input) {
  return violationEntryWithAnalysis(input, createFileAnalysis(input.source, input.filePath));
}

export function collectEntries(results) {
  const entries = new Map();
  for (const result of results) {
    if (result.fatalErrorCount > 0) continue;
    let analysis;
    for (const message of result.messages) {
      if (!Object.hasOwn(RULES, message.ruleId)) continue;
      const source = result.source ?? '';
      analysis ??= createFileAnalysis(source, result.filePath);
      const entry = violationEntryWithAnalysis({ filePath: result.filePath, message, source }, analysis);
      const key = stableJson({ file: entry.file, ruleId: entry.ruleId, stableId: entry.stableId });
      const previous = entries.get(key);
      entries.set(key, {
        ...entry,
        metric: Math.max(entry.metric, previous?.metric ?? entry.metric),
        normalizedMessage: normalizeMetricMessage(entry.ruleId, Math.max(entry.metric, previous?.metric ?? entry.metric)),
        count: (previous?.count ?? 0) + 1
      });
    }
  }
  return [...entries.values()].sort(compareBaselineEntries);
}

function compareBaselineEntries(left, right) {
  const leftKey = stableJson(left);
  const rightKey = stableJson(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function createBaseline(entries, extra = metadata()) {
  return { ...extra, entries: [...entries].sort(compareBaselineEntries) };
}

export function validateBaseline(baseline, expected = metadata()) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return 'baseline must be an object';
  for (const key of ['schemaVersion', 'toolchain', 'configDigest', 'scopeDigest', 'entries']) {
    if (!Object.hasOwn(baseline, key)) return `baseline is missing ${key}`;
  }
  if (baseline.schemaVersion !== expected.schemaVersion) return `unsupported baseline schemaVersion ${baseline.schemaVersion}`;
  for (const key of ['toolchain', 'configDigest', 'scopeDigest']) {
    if (stableJson(baseline[key]) !== stableJson(expected[key])) return `baseline ${key} does not match the current lint configuration`;
  }
  if (!Array.isArray(baseline.entries)) return 'baseline entries must be an array';
  for (const entry of baseline.entries) {
    if (!entry || typeof entry !== 'object' ||
      typeof entry.file !== 'string' || typeof entry.ruleId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.stableId) || typeof entry.displayName !== 'string' ||
      !Number.isSafeInteger(entry.metric) || entry.metric < 1 || !Number.isSafeInteger(entry.count) || entry.count < 1) {
      return 'baseline contains an invalid violation entry';
    }
  }
  return null;
}

export function compareEntries(baselineEntries, currentEntries) {
  const key = ({ file, ruleId, stableId }) => stableJson({ file, ruleId, stableId });
  const baseline = new Map(baselineEntries.map((entry) => [key(entry), entry]));
  const current = new Map(currentEntries.map((entry) => [key(entry), entry]));
  const errors = [];

  for (const [fingerprint, currentEntry] of current) {
    const previousEntry = baseline.get(fingerprint);
    if (!previousEntry) errors.push({ kind: 'new', entry: currentEntry, count: currentEntry.count, previous: 0 });
  }
  for (const [fingerprint, baselineEntry] of baseline) {
    if (!current.has(fingerprint)) errors.push({ kind: 'stale', entry: baselineEntry, count: 0, previous: baselineEntry.count });
  }
  return errors;
}

async function lint() {
  const eslint = new ESLint({
    cwd: ROOT_DIR,
    overrideConfigFile: path.join(TOOL_DIR, 'eslint.config.mjs')
  });
  const results = await eslint.lintFiles(SCOPE);
  return { eslint, results, fatalErrorCount: results.reduce((sum, result) => sum + result.fatalErrorCount, 0), entries: collectEntries(results) };
}

function atomicWriteBaseline(baseline) {
  const temporaryPath = `${BASELINE_PATH}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporaryPath, BASELINE_PATH);
}

function printScan({ results, fatalErrorCount, entries }) {
  const counts = Object.fromEntries(Object.keys(RULES).map((ruleId) => [ruleId, entries.reduce((sum, entry) => sum + (entry.ruleId === ruleId ? entry.count : 0), 0)]));
  process.stdout.write(`${JSON.stringify({ files: results.length, fatalErrorCount, counts, entries }, null, 2)}\n`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const allowedArgs = new Set(['--scan', '--write-baseline']);
  const unknownArg = [...args].find((argument) => !allowedArgs.has(argument));
  if (unknownArg || (args.has('--scan') && args.has('--write-baseline'))) {
    process.stderr.write('Usage: node run-lint.mjs [--scan | --write-baseline]\n');
    process.exitCode = 2;
    return;
  }
  if (args.has('--write-baseline') && (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true')) {
    process.stderr.write('Refusing to write the ESLint baseline in a CI environment.\n');
    process.exitCode = 2;
    return;
  }
  const scan = await lint();
  if (args.has('--scan')) {
    printScan(scan);
    if (scan.fatalErrorCount) process.exitCode = 1;
    return;
  }
  if (scan.fatalErrorCount) {
    process.stderr.write(`ESLint reported ${scan.fatalErrorCount} fatal parsing/configuration error(s).\n`);
    process.exitCode = 1;
    return;
  }
  if (args.has('--write-baseline')) {
    atomicWriteBaseline(createBaseline(scan.entries));
    process.stdout.write(`Wrote ${scan.entries.length} baseline fingerprint(s) to ${path.relative(ROOT_DIR, BASELINE_PATH)}; review the diff before committing.\n`);
    return;
  }
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (error) {
    process.stderr.write(`Cannot read baseline ${path.relative(ROOT_DIR, BASELINE_PATH)}: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const invalid = validateBaseline(baseline);
  if (invalid) {
    process.stderr.write(`Invalid baseline: ${invalid}\n`);
    process.exitCode = 1;
    return;
  }
  const errors = compareEntries(baseline.entries, scan.entries);
  for (const item of errors) {
    const entry = item.entry;
    process.stderr.write(`${item.kind}: ${entry.file} ${entry.ruleId} ${entry.displayName} ${entry.normalizedMessage} (baseline ${item.previous}, current ${item.count})\n`);
  }
  if (errors.length) process.exitCode = 1;
  else process.stdout.write(`ESLint baseline check passed for ${scan.results.length} files (${scan.entries.length} fingerprints).\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { main };
