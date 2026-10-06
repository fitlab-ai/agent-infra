import crypto from 'node:crypto';

import type { CodexControllerLeaseProofV1 } from './controller-registration.ts';

export type CodexHookAttestationClaims = Readonly<{
  requestId: string;
  token: string;
  generation: string;
  issuedAt: number;
  expiresAt: number;
  taskId: string;
  controllerProof: CodexControllerLeaseProofV1;
  attestation: readonly [string, string, string, string, string];
}>;

function canonicalClaims(claims: CodexHookAttestationClaims): string {
  return JSON.stringify({
    requestId: claims.requestId,
    token: claims.token,
    generation: claims.generation,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    taskId: claims.taskId,
    controllerProof: claims.controllerProof,
    attestation: claims.attestation
  });
}

export function signCodexHookAttestation(claims: CodexHookAttestationClaims, privateKey: string): string {
  return crypto.sign(null, Buffer.from(canonicalClaims(claims)), privateKey).toString('base64url');
}

export function verifyCodexHookAttestation(
  claims: CodexHookAttestationClaims,
  signature: string,
  publicKey: string
): boolean {
  try {
    return crypto.verify(null, Buffer.from(canonicalClaims(claims)), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
