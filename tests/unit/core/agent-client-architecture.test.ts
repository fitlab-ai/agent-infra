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
    filePath('lib/builtin-tuis.ts'),
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

test('generic sandbox lifecycle contains no Codex-specific ID literals', () => {
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
      return findClientIdLiterals(sourceFile, displayPath, ['codex']);
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
