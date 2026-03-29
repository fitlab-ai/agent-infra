#!/bin/sh

set -e

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

gh label list --limit 200 --json name --jq '.[].name' > "$tmpdir/existing-names.txt"
cp "$tmpdir/existing-names.txt" "$tmpdir/existing.txt"
echo "Existing labels:"
cat "$tmpdir/existing-names.txt"

cat <<'EOF' > "$tmpdir/common.tsv"
type: bug	DED6F9	A general bug
type: enhancement	DED6F9	A general enhancement
type: feature	DED6F9	A general feature
type: documentation	DED6F9	A documentation task
type: dependency-upgrade	DED6F9	A dependency upgrade
type: task	DED6F9	A general task
status: waiting-for-triage	FCF1C4	An issue we've not yet triaged or decided on
status: waiting-for-feedback	FCF1C4	We need additional information before we can continue
status: feedback-provided	FCF1C4	Feedback has been provided
status: feedback-reminder	FCF1C4	We've sent a reminder that we need additional information before we can continue
status: pending-design-work	FCF1C4	Needs design work before any code can be developed
status: in-progress	FCF1C4	Work is actively being developed
status: on-hold	FCF1C4	We can't start working on this issue yet
status: blocked	FCF1C4	An issue that's blocked on an external project change
status: declined	FCF1C4	A suggestion or change that we don't feel we should currently apply
status: duplicate	FCF1C4	A duplicate of another issue
status: invalid	FCF1C4	An issue that we don't feel is valid
status: superseded	FCF1C4	An issue that has been superseded by another
status: bulk-closed	FCF1C4	An outdated, unresolved issue that's closed in bulk as part of a cleaning process
status: ideal-for-contribution	FCF1C4	An issue that a contributor can help us with
status: backported	FCF1C4	An issue that has been backported to maintenance branches
status: waiting-for-internal-feedback	FCF1C4	An issue that needs input from a member or another team
good first issue	F9D9E6	Good for newcomers
help wanted	008672	Extra attention is needed
dependencies	0366d6	Pull requests that update a dependency file
EOF

while IFS="$(printf '\t')" read -r name color description; do
  [ -n "$name" ] || continue
  gh label create "$name" --color "$color" --description "$description" --force
done < "$tmpdir/common.tsv"

gh label list --limit 200 --json name --jq '.[].name' > "$tmpdir/final-names.txt"
cp "$tmpdir/final-names.txt" "$tmpdir/final.txt"

: > "$tmpdir/unmatched-defaults.txt"
for label in bug documentation duplicate enhancement invalid question wontfix; do
  if grep -Fqx "$label" "$tmpdir/final-names.txt"; then
    printf '%s\n' "$label" >> "$tmpdir/unmatched-defaults.txt"
  fi
done

common_count="$(wc -l < "$tmpdir/common.tsv" | tr -d ' ')"

echo "GitHub Labels initialized."
echo
echo "Summary:"
echo "- Common labels created or updated: $common_count"
echo "- Exact-match GitHub defaults overwritten: good first issue, help wanted"

if [ -s "$tmpdir/unmatched-defaults.txt" ]; then
  echo "- Unmatched GitHub defaults still present:"
  sed 's/^/  - /' "$tmpdir/unmatched-defaults.txt"
else
  echo "- Unmatched GitHub defaults still present: none"
fi

echo
echo "Notes:"
echo "- theme: labels were intentionally not created."
echo "- The operation is idempotent because every label uses gh label create --force."
echo "- in: labels are managed by the AI-guided step in the SKILL."
