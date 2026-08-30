import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { API } from 'typescript/unstable/sync';
import {
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteral
} from 'typescript/unstable/ast';
import type { Node, SourceFile } from 'typescript/unstable/ast';

import { AGENT_CLIENT_IDS } from '../../../lib/agent-clients/types.ts';
import {
  createAgentClientManifest,
  listAgentClientAdapters
} from '../../../lib/agent-clients/registry.ts';
import { filePath } from '../../helpers.ts';

type Finding = Readonly<{
  file: string;
  line: number;
  column: number;
  value: string;
}>;

function findClientIdLiterals(
  sourceFile: SourceFile,
  displayPath: string,
  clientIds: readonly string[] = AGENT_CLIENT_IDS
): Finding[] {
  const findings: Finding[] = [];
  const ids = new Set<string>(clientIds);

  function visit(node: Node): void {
    if (
      isStringLiteral(node)
      && ids.has(node.text)
      && !(
        (isImportDeclaration(node.parent) || isExportDeclaration(node.parent))
        && node.parent.moduleSpecifier === node
      )
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      findings.push({
        file: displayPath,
        line: position.line + 1,
        column: position.character + 1,
        value: node.text
      });
    }
    node.forEachChild(visit);
  }

  visit(sourceFile);
  return findings;
}

function findAdapterModuleEdges(sourceFile: SourceFile, displayPath: string): Finding[] {
  const findings: Finding[] = [];
  function visit(node: Node): void {
    if (
      isStringLiteral(node)
      && (isImportDeclaration(node.parent) || isExportDeclaration(node.parent))
      && node.parent.moduleSpecifier === node
      && node.text.includes('/agent-clients/adapters/')
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      findings.push({
        file: displayPath,
        line: position.line + 1,
        column: position.character + 1,
        value: node.text
      });
    }
    node.forEachChild(visit);
  }
  visit(sourceFile);
  return findings;
}

function findPathReferences(
  content: string,
  displayPath: string,
  values: readonly string[]
): Finding[] {
  return values.flatMap((value) => {
    const findings: Finding[] = [];
    let offset = content.indexOf(value);
    while (offset >= 0) {
      const prefix = content.slice(0, offset);
      const lines = prefix.split('\n');
      findings.push({
        file: displayPath,
        line: lines.length,
        column: lines.at(-1)!.length + 1,
        value
      });
      offset = content.indexOf(value, offset + value.length);
    }
    return findings;
  });
}

function findPathLiteralReferences(
  sourceFile: SourceFile,
  displayPath: string,
  values: readonly string[]
): Finding[] {
  const findings: Finding[] = [];
  function visit(node: Node): void {
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    if (children.length === 0) {
      const text = node.getText(sourceFile);
      for (const value of values) {
        let relativeOffset = text.indexOf(value);
        while (relativeOffset >= 0) {
          const position = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile) + relativeOffset
          );
          findings.push({
            file: displayPath,
            line: position.line + 1,
            column: position.character + 1,
            value
          });
          relativeOffset = text.indexOf(value, relativeOffset + value.length);
        }
      }
    }
    children.forEach(visit);
  }
  visit(sourceFile);
  return findings;
}

function listTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(child);
    return entry.isFile() && entry.name.endsWith('.ts') ? [child] : [];
  });
}

test('generic Agent Client core contains no client-specific ID literals', () => {
  const agentClientsRoot = filePath('lib/agent-clients');
  const candidates = [
    ...listTypeScriptFiles(agentClientsRoot).filter((candidate) => {
      const relative = path.relative(agentClientsRoot, candidate).replace(/\\/g, '/');
      // types.ts and tokens.ts are the canonical vocabulary definitions
      // (client IDs / activity-log agent tokens); adapters are client-scoped.
      return relative !== 'types.ts' && relative !== 'tokens.ts' && !relative.startsWith('adapters/');
    }),
    filePath('lib/sandbox/agent-client-reconciler.ts')
  ];

  const api = new API({ cwd: filePath('.') });
  const snapshot = api.updateSnapshot({
    openProjects: [filePath('tsconfig.test.json')]
  });
  try {
    const project = snapshot.getProjects()[0];
    assert.ok(project);

    const findings = candidates.flatMap((candidate) => {
      const displayPath = path.relative(filePath('.'), candidate).replace(/\\/g, '/');
      const sourceFile = project.program.getSourceFile(candidate);
      assert.ok(sourceFile, `expected ${displayPath} in the TypeScript program`);
      return findClientIdLiterals(sourceFile, displayPath);
    });

    assert.deepEqual(
      findings,
      [],
      findings.map((finding) =>
        `${finding.file}:${finding.line}:${finding.column} contains ${finding.value}`
      ).join('\n')
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
});

test('generic sandbox lifecycle contains no migrated client-specific ID literals', () => {
  const candidates = [
    filePath('lib/sandbox/commands/create.ts'),
    filePath('lib/sandbox/recovery.ts')
  ];
  const api = new API({ cwd: filePath('.') });
  const snapshot = api.updateSnapshot({
    openProjects: [filePath('tsconfig.test.json')]
  });

  try {
    const project = snapshot.getProjects()[0];
    assert.ok(project);
    const findings = candidates.flatMap((candidate) => {
      const displayPath = path.relative(filePath('.'), candidate).replace(/\\/g, '/');
      const sourceFile = project.program.getSourceFile(candidate);
      assert.ok(sourceFile, `expected ${displayPath} in the TypeScript program`);
      return findClientIdLiterals(sourceFile, displayPath, ['codex', 'opencode']);
    });

    assert.deepEqual(
      findings,
      [],
      findings.map((finding) =>
        `${finding.file}:${finding.line}:${finding.column} contains ${finding.value}`
      ).join('\n')
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
});

test('generic sandbox modules do not import or export adapter implementation modules', () => {
  const candidates = [
    'lib/sandbox/agent-client-reconciler.ts',
    'lib/sandbox/commands/create.ts',
    'lib/sandbox/commands/rebuild.ts',
    'lib/sandbox/dockerfile.ts',
    'lib/sandbox/recovery.ts'
  ].map(filePath);
  const api = new API({ cwd: filePath('.') });
  const snapshot = api.updateSnapshot({ openProjects: [filePath('tsconfig.test.json')] });
  try {
    const project = snapshot.getProjects()[0];
    assert.ok(project);
    const findings = candidates.flatMap((candidate) => {
      const displayPath = path.relative(filePath('.'), candidate).replace(/\\/g, '/');
      const sourceFile = project.program.getSourceFile(candidate);
      assert.ok(sourceFile, `expected ${displayPath} in the TypeScript program`);
      return findAdapterModuleEdges(sourceFile, displayPath);
    });
    assert.deepEqual(findings, []);
  } finally {
    snapshot.dispose();
    api.close();
  }
});

test('template sync command cleanup uses manifest targets instead of client paths', () => {
  const commandPrefixes = createAgentClientManifest().flatMap((entry) => {
    const target = entry.customCommand?.target;
    if (!target) return [];
    return [target.slice(0, target.indexOf('${skillName}'))];
  });
  const sourcePath = filePath('src/sync-templates.js');
  const api = new API({ cwd: filePath('.') });
  const snapshot = api.updateSnapshot({ openProjects: [filePath('tsconfig.jschecks.json')] });
  try {
    const project = snapshot.getProjects()[0];
    assert.ok(project);
    const sourceFile = project.program.getSourceFile(sourcePath);
    assert.ok(sourceFile);
    assert.deepEqual(
      findPathLiteralReferences(sourceFile, 'src/sync-templates.js', commandPrefixes),
      []
    );
  } finally {
    snapshot.dispose();
    api.close();
  }
});

test('generic runtime Dockerfiles contain no adapter-owned state paths', () => {
  const adapterPaths = listAgentClientAdapters().flatMap((adapter) => {
    const tool = adapter.sandbox.createTool({ home: '/fixture-home', project: 'demo' });
    return [
      tool.containerMount,
      ...(adapter.sandbox.image?.dotfilesExclusions ?? []).map((entry) => `/home/devuser/${entry}`)
    ];
  });
  const runtimesRoot = filePath('lib/sandbox/runtimes');
  const findings = fs.readdirSync(runtimesRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.dockerfile'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const displayPath = `lib/sandbox/runtimes/${entry.name}`;
      return findPathReferences(
        fs.readFileSync(path.join(runtimesRoot, entry.name), 'utf8'),
        displayPath,
        adapterPaths
      );
    });
  assert.deepEqual(findings, []);
});

test('architecture scanner reports an exact source location', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-architecture-'));
  const fixturePath = path.join(fixtureDir, 'fixture.ts');
  fs.writeFileSync(fixturePath, "const client =\n  'codex';\n", 'utf8');
  const api = new API({ cwd: fixtureDir });

  try {
    const snapshot = api.updateSnapshot({ openFiles: [fixturePath] });
    const project = snapshot.getDefaultProjectForFile(fixturePath);
    assert.ok(project);
    const sourceFile = project.program.getSourceFile(fixturePath);
    assert.ok(sourceFile);
    assert.deepEqual(findClientIdLiterals(sourceFile, 'fixture.ts'), [{
      file: 'fixture.ts',
      line: 2,
      column: 3,
      value: 'codex'
    }]);
    snapshot.dispose();
  } finally {
    api.close();
    fs.unlinkSync(fixturePath);
    fs.rmdirSync(fixtureDir);
  }
});

test('architecture boundary scanners report exact source locations', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-client-boundaries-'));
  const fixturePath = path.join(fixtureDir, 'fixture.ts');
  fs.writeFileSync(fixturePath, "export * from '../agent-clients/adapters/codex-sandbox.ts';\n", 'utf8');
  const api = new API({ cwd: fixtureDir });
  try {
    const snapshot = api.updateSnapshot({ openFiles: [fixturePath] });
    const project = snapshot.getDefaultProjectForFile(fixturePath);
    assert.ok(project);
    const sourceFile = project.program.getSourceFile(fixturePath);
    assert.ok(sourceFile);
    assert.deepEqual(findAdapterModuleEdges(sourceFile, 'fixture.ts'), [{
      file: 'fixture.ts', line: 1, column: 15,
      value: '../agent-clients/adapters/codex-sandbox.ts'
    }]);
    assert.deepEqual(findPathReferences('first\n/home/devuser/.codex\n', 'fixture', ['/home/devuser/.codex']), [{
      file: 'fixture', line: 2, column: 1, value: '/home/devuser/.codex'
    }]);
    assert.deepEqual(
      findPathLiteralReferences(sourceFile, 'fixture.ts', ['../agent-clients/adapters/']),
      [{ file: 'fixture.ts', line: 1, column: 16, value: '../agent-clients/adapters/' }]
    );
    snapshot.dispose();
  } finally {
    api.close();
    fs.unlinkSync(fixturePath);
    fs.rmdirSync(fixtureDir);
  }
});
