import test from 'node:test';
import assert from 'node:assert/strict';

import { ARTIFACT_FAMILY_CATALOG, artifactName, maxArtifactRound, parseArtifactName } from '../../../lib/task/artifact-name.ts';

test('artifact identities round-trip across every supported family', () => {
  for (const { family } of ARTIFACT_FAMILY_CATALOG) {
    for (const round of [1, 2, 10, Number.MAX_SAFE_INTEGER]) {
      const name = artifactName(family, round);
      assert.deepEqual(parseArtifactName(name), { name, family, round });
    }
    for (const suffix of ['r0', 'r1', 'r01', 'r02', 'r-2', 'r1.5', 'r9007199254740992']) {
      assert.equal(parseArtifactName(`${family}-${suffix}.md`), null);
    }
  }
  for (const name of ['../analysis.md', 'nested/analysis.md', 'nested\\analysis.md', 'unknown.md', 'Analysis.md', 'analysis-r2.md\n']) {
    assert.equal(parseArtifactName(name), null);
  }
});

test('maximum artifact round ignores other families and noncanonical names', () => {
  assert.equal(maxArtifactRound([], 'analysis'), 0);
  assert.equal(maxArtifactRound(['analysis.md', 'analysis-r2.md', 'analysis-r099.md', 'analysis-r9007199254740992.md', 'review-code-r9.md'], 'analysis'), 2);
});
