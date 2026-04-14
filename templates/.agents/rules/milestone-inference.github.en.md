# Milestone Inference Rules

Read this file before `create-issue`, `implement-task`, or `create-pr` handles a milestone.

## General Principles

- Narrow the milestone over the skill lifecycle: release line -> concrete version -> reuse
- Every phase must fall back safely instead of blocking the skill
- If `gh` is unavailable, unauthenticated, or the GitHub API call fails, skip milestone handling and continue
- Before any repository-scoped `gh api`, `gh issue edit`, or Issue lookup runs, the caller must resolve `upstream_repo` and `has_triage`
- Only use milestones that actually exist in the repository; if a target milestone is unavailable, apply the fallback for that phase

## Branch Mode Detection

Use the following command to detect whether the repository has remote release-line branches:

```bash
git branch -r | grep -v 'HEAD' | grep -E 'origin/[0-9]+\.[0-9]+\.x$'
```

- Any output: multi-version branch mode
- No output: trunk mode

## Phase 1: `create-issue`

Goal: choose a coarse-grained release line when the Issue is created.

Priority:
1. If task.md provides a valid explicit `milestone`, use it
2. Otherwise infer a release line:
   - Trunk mode: query open `X.Y.x` milestones and choose the lowest release line
   - Multi-version branch mode: try open `X.Y.x` milestones and choose the lowest release line; if that is not reliable, fall back to `General Backlog`
3. If the inferred release line does not exist, fall back to `General Backlog`
4. If `General Backlog` also does not exist, omit `--milestone`

Suggested release-line query:

```bash
gh api "repos/$upstream_repo/milestones?state=open&per_page=100" \
  --jq '.[].title'
```

Only match titles in `X.Y.x` format and choose the smallest major/minor pair numerically.

Direct milestone writes are triage-gated. When the caller detected `has_triage=false`, omit `--milestone` and continue.

## Phase 2: `implement-task`

Goal: narrow the Issue milestone from a release line to a concrete version when implementation starts.

Preconditions:
- task.md contains a valid `issue_number`
- the current Issue milestone matches the release-line format `X.Y.x`

Sequence:
1. Query the current Issue milestone
2. If it is not in `X.Y.x` format, treat it as already specific enough and keep it unchanged
3. If it is in `X.Y.x` format, narrow it according to branch mode:
   - Trunk mode: query open concrete-version milestones on that release line (for example `0.4.4`) and choose the latest one
   - Multi-version branch mode:
     - If the task branch was created from `origin/X.Y.x`, choose the latest concrete version on that line
     - If the task branch was created from `main`, find the highest release line and choose the latest concrete version on that line
4. When a target concrete version is found, run:

```bash
if [ "$has_triage" = "true" ]; then
  gh issue edit {issue-number} -R "$upstream_repo" --milestone "{version}"
fi
```

5. If `has_triage=false`, the target milestone does not exist, or the branch ancestry cannot be determined reliably, keep the original milestone unchanged

Suggested concrete-version query:

```bash
gh api "repos/$upstream_repo/milestones?state=open&per_page=100" \
  --jq '.[].title'
```

- Release-line match: `^X\.Y\.x$`
- Concrete-version match: `^X\.Y\.[0-9]+$`
- "Latest" means the largest patch number

Suggested branch-origin checks:

```bash
git merge-base --is-ancestor origin/{release-line} HEAD
git merge-base --is-ancestor origin/main HEAD
```

If neither check is reliable or the remote refs are unavailable, keep the original milestone and avoid guessing.

## Phase 3: `create-pr`

Goal: reuse the linked Issue milestone on the PR instead of inferring a new one.

Sequence:
1. If `issue_number` exists, query the Issue milestone
2. If the Issue has a milestone, run:

```bash
if [ "$has_triage" = "true" ]; then
  gh pr edit {pr-number} --milestone "{milestone}"
fi
```

3. If the Issue has no milestone, or `has_triage=false`, skip PR milestone assignment

Do not infer a PR milestone separately from task.md, branch names, tags, or `General Backlog`.
