# Release Guide

## Overview

This repository publishes `@fitlab-ai/agent-infra` with GitHub Actions and npm Trusted Publishing. The release workflow does not use a long-lived `NPM_TOKEN`; npm receives a short-lived publishing credential through GitHub Actions OIDC when `npm publish --provenance` runs.

## One-time maintainer setup on npmjs.com

Before the first OIDC-based release, a maintainer must configure the npm package:

- Package: `@fitlab-ai/agent-infra`
- Path: `npmjs.com -> Package -> Settings -> Publishing access -> Add Trusted Publisher`
- Publisher: GitHub Actions
- Organization or user: `fitlab-ai`
- Repository: `agent-infra`
- Workflow filename: `release.yml`
- Environment name: leave empty

The workflow filename must match `.github/workflows/release.yml`. Do not configure an environment unless the workflow is updated to use the same environment name.

## Normal release flow

1. Bump the package version locally.
2. Push a tag named `vX.Y.Z`.
3. Let the `release.yml` workflow publish the package with OIDC and `npm publish --provenance`.
4. Confirm the npm package page shows the Provenance badge.

## First-time OIDC cutover playbook

Use this order for the first release after switching away from token-based publishing:

- [ ] Maintainer has completed the Trusted Publisher binding on npmjs.com with the fields above.
- [ ] Push an alpha tag, such as `v0.5.11-alpha.0`, to validate OIDC publishing end to end.
- [ ] Confirm the `Provenance` badge is visible on npmjs.com.
- [ ] Only after the alpha publish and provenance check pass, remove the `NPM_TOKEN` secret from GitHub Settings.

Do not delete `NPM_TOKEN` before the first OIDC publish succeeds. Keeping it temporarily available preserves a rollback path.

## Rollback to token mode

If the first OIDC publish fails because the Trusted Publisher binding is missing or incorrect:

1. Revert the workflow change that removed `NODE_AUTH_TOKEN`.
2. Recreate the `NPM_TOKEN` GitHub secret if it has already been removed.
3. Re-run the release after the token-mode workflow is restored.
4. Fix the npmjs.com Trusted Publisher configuration outside the release incident, then try the OIDC cutover again with a new alpha tag.

Prefer restoring the known token-mode path before investigating npmjs.com settings during a blocked release.

## Why no environment and no automated secret deletion

The npm Trusted Publisher environment name is intentionally left empty. This avoids a second value that must match exactly between npmjs.com and GitHub Actions.

The `NPM_TOKEN` secret is removed manually only after an alpha OIDC publish and provenance check pass. The release workflow and AI agents must not delete the secret automatically, because doing so can remove the rollback path before the new publishing path has been proven.
