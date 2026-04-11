#!/bin/sh

set -e

arguments=""
if [ "$#" -gt 0 ]; then
  arguments="$*"
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (\`gh\`) is not installed"
  exit 1
fi

if ! gh auth token >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated"
  exit 1
fi

if ! gh repo view --json nameWithOwner >/dev/null 2>&1; then
  echo "Unable to access the current repository with gh"
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM

history_mode="false"

case " $arguments " in
  *" --history "*) history_mode="true" ;;
esac

echo "History mode: $history_mode"

current_version=""
latest_tag="$(git tag --list 'v*' --sort=-v:refname | head -1)"

if [ -n "$latest_tag" ]; then
  current_version="${latest_tag#v}"
elif [ -f package.json ]; then
  current_version="$(node -p "const version = require('./package.json').version || ''; version.replace(/^v/, '').replace(/-.*/, '')")"
fi

if [ -z "$current_version" ]; then
  current_version="0.1.0"
fi

major="${current_version%%.*}"
rest="${current_version#*.}"
minor="${rest%%.*}"
patch="${rest#*.}"
patch="${patch%%[^0-9]*}"

if ! printf '%s %s %s\n' "$major" "$minor" "$patch" | grep -Eq '^[0-9]+ [0-9]+ [0-9]+$'; then
  echo "Unable to determine current version baseline"
  exit 1
fi

line_milestone="$major.$minor.x"
next_version="$major.$minor.$((patch + 1))"

echo "Detected version baseline: $current_version"
echo "Line milestone: $line_milestone"
echo "Next version milestone: $next_version"

repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"

gh api "repos/$repo/milestones?state=all" --paginate \
  --jq '.[] | [.title, .state] | @tsv' > "$tmpdir/existing.tsv"

cut -f1 "$tmpdir/existing.tsv" > "$tmpdir/existing-titles.txt"
echo "Existing milestones:"
cat "$tmpdir/existing.tsv"

cat <<EOF > "$tmpdir/desired.tsv"
General Backlog	All unsorted backlogged tasks may be completed in a future version.	open
$line_milestone	Issues that we want to resolve in $major.$minor line.	open
$next_version	Issues that we want to release in v$next_version.	open
EOF

if [ "$history_mode" = "true" ]; then
  git tag --list 'v*' --sort=v:refname > "$tmpdir/history-tags.txt"

  if [ ! -s "$tmpdir/history-tags.txt" ]; then
    echo "No history tags found matching v*; only standard milestones will be created."
  else
    while IFS= read -r tag; do
      [ -n "$tag" ] || continue

      ver="${tag#v}"
      h_major="${ver%%.*}"
      h_rest="${ver#*.}"
      h_minor="${h_rest%%.*}"
      h_patch="${h_rest#*.}"
      h_patch="${h_patch%%[^0-9]*}"

      if ! printf '%s %s %s\n' "$h_major" "$h_minor" "$h_patch" | grep -Eq '^[0-9]+ [0-9]+ [0-9]+$'; then
        echo "Skip non-semver tag: $tag"
        continue
      fi

      printf '%s\t%s\t%s\n' \
        "$h_major.$h_minor.x" \
        "Issues that we want to resolve in $h_major.$h_minor line." \
        "open" >> "$tmpdir/desired.tsv"

      printf '%s\t%s\t%s\n' \
        "$h_major.$h_minor.$h_patch" \
        "Issues that we want to release in v$h_major.$h_minor.$h_patch." \
        "closed" >> "$tmpdir/desired.tsv"
    done < "$tmpdir/history-tags.txt"
  fi
fi

: > "$tmpdir/created.txt"
: > "$tmpdir/skipped.txt"

while IFS="$(printf '\t')" read -r title description state; do
  [ -n "$title" ] || continue
  state="${state:-open}"

  if grep -Fqx "$title" "$tmpdir/existing-titles.txt"; then
    printf '%s\n' "$title" >> "$tmpdir/skipped.txt"
    echo "Skip existing milestone: $title"
    continue
  fi

  gh api "repos/$repo/milestones" \
    -f title="$title" \
    -f description="$description" \
    -f state="$state" >/dev/null

  printf '%s\n' "$title" >> "$tmpdir/created.txt"
  printf '%s\n' "$title" >> "$tmpdir/existing-titles.txt"
  echo "Created milestone: $title ($state)"
done < "$tmpdir/desired.tsv"

created_count="$(wc -l < "$tmpdir/created.txt" | tr -d ' ')"
skipped_count="$(wc -l < "$tmpdir/skipped.txt" | tr -d ' ')"

echo "GitHub Milestones initialized."
echo
echo "Summary:"
echo "- Version baseline: $current_version"
echo "- History mode: $history_mode"
echo "- Created milestones: $created_count"
echo "- Skipped existing milestones: $skipped_count"

if [ -s "$tmpdir/created.txt" ]; then
  echo "- Newly created:"
  sed 's/^/  - /' "$tmpdir/created.txt"
fi

if [ -s "$tmpdir/skipped.txt" ]; then
  echo "- Already present:"
  sed 's/^/  - /' "$tmpdir/skipped.txt"
fi

echo
echo "Notes:"
echo "- Milestone titles are treated as the idempotency key."
echo "- General Backlog is the fallback milestone for unsorted work."
echo "- Without --history, version milestones are created only for the next patch release."

if [ "$history_mode" = "true" ]; then
  echo "- Historical X.Y.Z tags create X.Y.x milestones as open and X.Y.Z milestones as closed."
  echo "- Repositories with many tags may hit the GitHub API rate limit."
fi
