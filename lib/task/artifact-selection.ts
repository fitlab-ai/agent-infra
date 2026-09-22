import type { ArtifactFamily } from './artifact-name.ts';

type SelectionArtifact = Readonly<{
  family: ArtifactFamily;
  round: number;
  name: string;
}>;

type ArtifactDisposition = 'create' | 'resume' | 'reuse';

type ArtifactSelection = Readonly<{
  disposition: ArtifactDisposition;
  reasonCode: string;
  artifact: SelectionArtifact;
  writeRequired: boolean;
}>;

type ArtifactSelectionRequest = Readonly<{
  next: SelectionArtifact;
  latest: SelectionArtifact | null;
  open: boolean;
  hasChangeEvidence: boolean;
}>;

function selectArtifactDisposition(request: ArtifactSelectionRequest): ArtifactSelection {
  if (request.open) {
    return {
      disposition: 'resume', reasonCode: 'open-round', artifact: request.next,
      writeRequired: true
    };
  }
  if (!request.latest) {
    return {
      disposition: 'create',
      reasonCode: request.next.round === 1 ? 'no-history' : 'invalidated-history',
      artifact: request.next, writeRequired: true
    };
  }
  const reasonCode = request.hasChangeEvidence ? 'change-evidence' : 'history-matched';
  const reuse = reasonCode === 'history-matched';
  return {
    disposition: reuse ? 'reuse' : 'create',
    reasonCode,
    artifact: reuse ? request.latest : request.next,
    writeRequired: !reuse
  };
}

export { selectArtifactDisposition };
export type {
  ArtifactDisposition,
  ArtifactSelection,
};
