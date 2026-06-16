# Developer Guide

> English | [简体中文](./CONTRIBUTING.zh-CN.md)

## Introduction

This guide provides developers with detailed development guidance, covering branch management, tag management, commit rules, code review, and more. Following these guidelines helps the project develop efficiently and collaborate smoothly.

## Development Model

We use [Git](https://git-scm.com/) for version control, and the project follows a multi-version `Git-Flow` development model:

- The `main` branch is the trunk development branch; all features are checked out from and merged back into it
- `agent-infra-feature-*` branches are feature development branches
- `agent-infra-{$majorVersion}.{$minorVersion}.x` branches are version-specific branches
- `agent-infra-bugfix-*` branches are bug-fix branches
- Every bug fix or enhancement must be handled on the appropriate lowest version branch, then merged upward branch by branch until it reaches the `main` branch

## Environment Setup

### Prerequisites

- Git
- Node.js >= 22 (for the built-in test runner `node:test`)
- A shell (sh/bash/zsh)

### Quick Start

```bash
# Clone the project
git clone git@github.com:fitlab-ai/agent-infra.git

# Install dependencies: real npm dependencies must be installed after a development checkout
npm install

# Enable Git hooks (run once after the first clone)
git config core.hooksPath .git-hooks

# Build (required after modifying src/ or lib/)
npm run build

# Run tests
npm test

# Linting: no lint tool configured yet
```

Refer to the project's `README.md` for more guidance on how to set up the development environment.

## Branch Management

- Create a new branch for every feature or bug fix; avoid developing directly on the main branch (e.g. `main`).
- Branch names should be concise and clearly describe the branch's main purpose.
  - Branches start with `agent-infra-`.
  - Feature branches start with `agent-infra-feature-`, enhancement branches with `agent-infra-enhancement-`, task branches with `agent-infra-task-`, and bug-fix branches with `agent-infra-bugfix-`.
  - Use hyphens `-` to separate words.
  - Version branches end with two version numbers and the letter `x`, e.g. `agent-infra-1.0.x`.
  - Release branches end with three version numbers, e.g. `agent-infra-1.0.0`.

### Version Branch Merge Rules

- Version branch merges must follow the principle of merging from lower versions to higher versions, and must not skip any version.
- After any `feature`, `enhancement`, or `bugfix` is merged into a version-specific branch, it must be merged upward in order until it reaches the `main` branch.

## Tag Management

- Each tag name must match the name of its release branch, e.g. `agent-infra-1.0.0`.
- Branches with purely numeric versions must start with `v`, e.g. `v0.1.0`.
- Release candidates end with a special suffix, e.g. `agent-infra-1.0.0-alpha1`.
- Once a tag is created, the corresponding release branch should be deleted.
- Every Issue and PR must include at least two kinds of labels: `in: {$module}` and `type: {$type}`.

## Development Standards

### Code Style

- `install.sh` stays POSIX sh compatible and uses `set -e` for error handling
- Template files use `{{project}}` and `{{org}}` as rendering placeholders
- User-facing Markdown files provide bilingual versions (English-first + Chinese translation), such as README and SECURITY

### Platform-Agnostic Layer vs Platform Layer

The templates in this repository must distinguish between the platform-agnostic baseline and platform-specific implementations. Platform-specific content may only live in the following locations:

- `.agents/rules/*.{platform}.md`
- `.agents/scripts/platform-adapters/platform-sync.{platform}.js`
- Scripts or workflow directories that explicitly belong to platform integration

Apart from the locations above, baseline files such as `SKILL.md`, `reference/*.md`, command palettes, QUICKSTART, and README must remain platform-agnostic. Baseline files should reference the abstract entry points in `.agents/rules/*.md` or `.agents/scripts/` rather than embedding platform commands, paths, or schemas directly.

When judging platform coupling, first check these hard indicators:

- Platform names, such as `GitHub`
- Platform paths, such as `.github/`
- Platform CLIs, such as `gh CLI` or commands starting with `gh `

Also manually check these soft indicators:

- Platform-specific schema field names, such as the GitHub Issue Forms `textarea`, `input`, `dropdown`, `checkboxes`, `attributes.label`
- Platform file naming conventions, such as `.yml` Issue Form file names and `PULL_REQUEST_TEMPLATE.md`
- Copies of commands or marker strings already defined in rules/scripts

`tests/unit/templates/platform-coupling.test.js` provides a structural guardrail: baseline content must not contain platform hard indicators, and skill reference directories must not add platform variants like `.github.*`. The test cannot cover all soft indicators, so PR authors and reviewers must still manually check schema fields, duplicated commands, and wording wrappers.

### Path-Level Platform Gating (init/sync implementation layer)

Paths under `templates/` whose top-level segment is `.{platform}/` (such as `.github/`, or a future `.gitlab/`) are automatically gated for distribution by `src/sync-templates.js` based on `cfg.platform.type`:

- When `cfg.platform.type` equals that platform: distribute and sync normally
- When `cfg.platform.type` is another `KNOWN_PLATFORMS` value or a custom platform: skip distribution and clean up any residual directory entries of the same name left in the project

Project-level (non-platform-specific) git hooks, configs, and so on should not be placed under `.{platform}/`; placing them in platform-neutral paths (such as `.git-hooks/`) is what makes them distributable across platforms.

Examples:

- Anti-pattern: writing `gh pr list --limit 3 --state merged` directly in `templates/.agents/skills/create-pr/reference/pr-body-template.en.md`
- Correct pattern: have the baseline reference say "run the recent-PR query command per `.agents/rules/issue-pr-commands.md`", and keep the GitHub-specific command only in `issue-pr-commands.github.en.md`

Adopted architectural decisions:

- `verify.json` should prefer referencing the platform adapter's default values via `expected_*_key` rather than copying marker or status label strings.
- `platform-sync.{platform}.js#getDefaults()` is the single source of truth for platform default markers and status labels.
- This key-based abstraction is a design reserved for multi-platform expansion: it collapses the configuration cost of N skills × M platforms into N key references + M adapter defaults.

### Build Architecture

- `src/sync-templates.js` is the development source code; it keeps a readable source structure and the standard way of reading `lib/` data files.
- `templates/.agents/skills/update-agent-infra/scripts/sync-templates.js` is the build artifact; at release time it inlines the default config and version number as constants.
- This build layer is needed because `sync-templates.js` is copied into user projects to run, where it can no longer depend on the `lib/` directory inside the installer repository.
- After modifying `src/`, `lib/defaults.json`, or related version information, run `npm run build` to regenerate the artifact; do not manually edit the generated files under `templates/`.

### Comments

- Every module file is recommended to include comments explaining its responsibility and purpose.
- All `export`ed classes, functions, interfaces, and so on must have documentation comments.

## Commit Rules

### Commit Message Format

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:
`<type>(<scope>): <subject>`

- **type**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`
- **scope (module)**: corresponds to the project module name. If multiple modules or a global change are involved, use `*` or leave it empty.
- **subject**: a short description of the main content, in the English imperative mood, no longer than 50 characters, with no trailing period.

**Examples:**
- `feat(ai): add multi-agent collaboration workflow`
- `fix(github): fix PR title validation regex`
- `docs(ai): update collaboration quick start guide`

## Code Review

- After development, merge your changes into the main branch by creating a merge request. Describe the changes you made in the merge request and invite other project members to review the code.
- Keep the main branch always deployable, and ensure merged code is thoroughly tested.

## Testing

- Test framework: Node.js built-in test runner (`node:test`, requires Node.js >= 22)
- Build command: `npm run build` (required after modifying `src/`, `lib/defaults.json`, or version information)
- Run command: `npm test`
- Equivalent to: `node scripts/build-inline.js --check && node --test tests/*.test.js`
- Test coverage: template file integrity, CLI initialization flow, placeholder rendering validation
- Always make sure all tests pass before committing

## Release Process

Follow the project's release plan and process. When releasing a new version, create a new `tag` per the tag management rules.

Maintainers, see [RELEASING.md](./RELEASING.md) for the npm release process and the one-time Trusted Publisher configuration.

## Issue and Requirement Tracking

Use the project's `Issue` tracker to report and track issues, requirements, and feature suggestions. When creating a new `Issue`, please provide as much detail as possible.

## Contribution Guidelines

Contributors who wish to participate in the project should follow these steps:

1. Fork this project.
2. Clone the forked repository locally.
3. Create a new branch in your local repository and develop on it.
4. Follow the commit conventions in this document and commit your changes to the new branch.
5. Create a PR through the web interface, requesting to merge your changes into the corresponding branch of the project; a PR may contain only a single commit.
6. Participate in code review and discussion, and make the necessary changes based on feedback.
7. Once your changes are accepted and merged, your contribution becomes part of the project.

> - Project maintainers may suggest changes; please stay open and communicate actively.
> - If you find a problem but are not ready to fix it yourself, you may submit just an Issue. If you have questions about the approach, you can ask in the "Discussions" section.
