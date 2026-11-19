import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const files = [];
function collect(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (entry.isFile() && file.endsWith('.ts')) files.push(file);
  }
}
collect(path.join(root, 'bin'));
collect(path.join(root, 'lib'));
files.sort();
const nodes = new Set(files);
const graph = new Map(files.map(file => [file, []]));
const errors = [];
const display = file => path.relative(root, file).split(path.sep).join('/');
for (const file of files) {
  let ast;
  try { ast = tseslint.parser.parseForESLint(fs.readFileSync(file, 'utf8'), { sourceType: 'module', loc: true }).ast; }
  catch (error) { errors.push(`${display(file)}: ${error.message}`); continue; }
  for (const node of ast.body) {
    if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) || !node.source) continue;
    if (node.importKind === 'type' || node.exportKind === 'type') continue;
    if (node.specifiers?.length && node.specifiers.every(spec => spec.importKind === 'type' || spec.exportKind === 'type')) continue;
    const specifier = node.source.value;
    if (typeof specifier !== 'string' || !specifier.startsWith('.')) continue;
    const base = path.resolve(path.dirname(file), specifier);
    const candidates = base.endsWith('.js') ? [base.slice(0, -3) + '.ts', base] : [base, `${base}.ts`, path.join(base, 'index.ts')];
    const target = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!target) errors.push(`${display(file)}:${node.loc.start.line}: unresolved import ${specifier}`);
    else if (nodes.has(target)) graph.get(file).push(target);
  }
  graph.get(file).sort();
}
let index = 0;
const indices = new Map(), low = new Map(), stack = [], active = new Set(), components = [];
function visit(file) {
  indices.set(file, index); low.set(file, index++); stack.push(file); active.add(file);
  for (const next of graph.get(file)) {
    if (!indices.has(next)) { visit(next); low.set(file, Math.min(low.get(file), low.get(next))); }
    else if (active.has(next)) low.set(file, Math.min(low.get(file), indices.get(next)));
  }
  if (low.get(file) === indices.get(file)) {
    const component = [];
    let next;
    do { next = stack.pop(); active.delete(next); component.push(next); } while (next !== file);
    if (component.length > 1 || graph.get(file).includes(file)) components.push(component.sort());
  }
}
for (const file of files) if (!indices.has(file)) visit(file);
for (const component of components.sort((a, b) => a[0].localeCompare(b[0]))) {
  const members = new Set(component);
  errors.push(`Cycle: ${component.map(display).join(', ')}`);
  for (const file of component) for (const next of graph.get(file)) if (members.has(next)) errors.push(`  ${display(file)} -> ${display(next)}`);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`No cycles in ${files.length} TypeScript files (static relative runtime imports and exports only).`);
