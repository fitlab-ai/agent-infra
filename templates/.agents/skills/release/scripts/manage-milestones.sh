#!/bin/sh

set -e

if [ "$#" -ne 3 ]; then
  echo "Usage: manage-milestones.sh <major> <minor> <patch>"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (\`gh\`) is not installed"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated"
  exit 1
fi

major="$1"
minor="$2"
patch="$3"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM

repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
released_version="${major}.${minor}.${patch}"
line_milestone="${major}.${minor}.x"
next_patch_version="${major}.${minor}.$((patch + 1))"
next_minor_version="${major}.$((minor + 1)).0"
next_minor_line="${major}.$((minor + 1)).x"

gh api "repos/$repo/milestones?state=all" --paginate \
  --jq '.[] | [.number, .title, .state] | @tsv' > "$tmpdir/milestones.tsv"

created_count=0

ensure_milestone() {
  title="$1"
  description="$2"

  if awk -F '\t' -v target="$title" '$2 == target { found = 1 } END { exit found ? 0 : 1 }' "$tmpdir/milestones.tsv"; then
    echo "Milestone already exists: $title"
    return 0
  fi

  gh api "repos/$repo/milestones" \
    -f title="$title" \
    -f description="$description" \
    -f state="open" >/dev/null

  printf '0\t%s\topen\n' "$title" >> "$tmpdir/milestones.tsv"
  created_count=$((created_count + 1))
  echo "Created milestone: $title"
}

released_number="$(awk -F '\t' -v target="$released_version" '$2 == target { print $1; exit }' "$tmpdir/milestones.tsv")"
released_state="$(awk -F '\t' -v target="$released_version" '$2 == target { print $3; exit }' "$tmpdir/milestones.tsv")"

if [ -n "$released_number" ] && [ "$released_state" = "open" ]; then
  gh api "repos/$repo/milestones/$released_number" -X PATCH -f state="closed" >/dev/null
  released_action="closed"
elif [ -n "$released_number" ]; then
  released_action="already-closed"
else
  released_action="missing"
fi

ensure_milestone "$next_patch_version" "Issues that we want to release in v$next_patch_version."
ensure_milestone "$line_milestone" "Issues that we want to resolve in $major.$minor line."

if [ "$patch" -eq 0 ]; then
  ensure_milestone "$next_minor_version" "Issues that we want to release in v$next_minor_version."
  ensure_milestone "$next_minor_line" "Issues that we want to resolve in $major.$((minor + 1)) line."
fi

echo "Milestone summary:"
echo "- Released milestone: $released_version ($released_action)"
echo "- New milestones created: $created_count"
