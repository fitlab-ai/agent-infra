# Developer Guide

## Introduction

This guide provides detailed development guidance for contributors, including branch management, tagging, commit rules, and code review.

## Development Model

We use [Git](https://git-scm.com/) for version control, following a multi-version Git-Flow model:

- `main` branch is the primary development branch; all features branch from and merge into it
- `collaborator-feature-*` branches for feature development
- `collaborator-{majorVersion}.{minorVersion}.x` for version branches
- `collaborator-bugfix-*` branches for bug fixes
- All bug fixes or enhancements must start from the lowest applicable version branch and merge upward to `main`

## Environment Setup

### Prerequisites

<!-- TODO: Add your project's prerequisites here -->

### Quick Start

```bash
# Clone the project
git clone <repository-url>

# Install dependencies
# TODO: Add your project's install command

# Build
# TODO: Add your project's build command

# Run tests
# TODO: Add your project's test command

# Lint
# TODO: Add your project's lint command
```

See the project's `README.md` for more details on configuring the development environment.

## Branch Management

- Create a new branch for each feature or bug fix; never develop directly on `main`.
- Branch naming should be concise and describe the branch's purpose.
  - Branches start with `collaborator-`.
  - Feature branches: `collaborator-feature-*`, enhancements: `collaborator-enhancement-*`, tasks: `collaborator-task-*`, bug fixes: `collaborator-bugfix-*`.
  - Use hyphens `-` to separate words.
  - Version branches end with two version numbers and `x`: `collaborator-1.0.x`.
  - Release branches end with three version numbers: `collaborator-1.0.0`.

### Version Branch Merge Rules

- Version branches must merge from lower to higher versions, without skipping.
- After any feature, enhancement, or bugfix merges into a version branch, it must be merged upward through each subsequent version branch until reaching `main`.

## Tag Management

- Tag names must match release branch names, e.g. `collaborator-1.0.0`.
- Purely numeric versions use a `v` prefix, e.g. `v0.1.0`.
- Release candidates use special suffixes, e.g. `collaborator-1.0.0-alpha1`.
- After a tag is created, the corresponding release branch should be deleted.
- All Issues and PRs must have at least two labels: `in: {module}` and `type: {type}`.

## Development Standards

### Code Style

<!-- TODO: Add your project's code style requirements here -->

### Comments

- Each module file should include comments explaining its purpose.
- All exported classes, functions, and interfaces need documentation comments.

## Commit Rules

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<scope>): <subject>`

- **type**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`
- **scope**: Module name. Use `*` or leave empty for cross-module changes.
- **subject**: Brief description in English imperative mood, max 50 characters, no trailing period.

Add a blank line after the subject for detailed description if necessary.

**Examples:**
- `feat(ai): add multi-agent collaboration workflow`
- `fix(github): fix PR title validation regex`
- `docs(ai): update collaboration quick start guide`

## Code Review

- Create a pull request to merge changes into the main branch. Describe your changes and invite team members for review.
- Keep the main branch always deployable; ensure merged code is tested and follows coding standards.

## Testing

<!-- TODO: Add your project's testing requirements here -->

## Release Process

Follow the project's release plan. When releasing a new version, create a tag per the tag management rules.

## Issue and Requirement Tracking

Use the project's Issue tracker to report and track issues, requirements, and feature suggestions. Provide detailed information when creating new Issues.

## Contribution Guide

For contributors:

1. Fork the project.
2. Clone your fork locally.
3. Create a new branch for development.
4. Follow the commit conventions in this document.
5. Create a PR to merge into the corresponding branch (one commit per PR).
6. Participate in code review and make necessary changes.
7. Once accepted and merged, your contribution becomes part of the project.

> - Maintainers may suggest modifications. Stay open and communicate actively.
> - If you find an issue but don't plan to fix it, submit an Issue. For questions, use the Discussions section.
