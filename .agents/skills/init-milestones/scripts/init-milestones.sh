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

parse_semver_tags() {
  LC_ALL=C awk -v mode="$1" '
    function valid_core_number(value) {
      return value ~ /^(0|[1-9][0-9]*)$/
    }

    function valid_identifiers(value, prerelease,    count, index_, identifiers) {
      if (value == "") return 0
      count = split(value, identifiers, ".")
      for (index_ = 1; index_ <= count; index_++) {
        if (identifiers[index_] !~ /^[0-9A-Za-z-]+$/) return 0
        if (prerelease && identifiers[index_] ~ /^[0-9]+$/ && identifiers[index_] !~ /^(0|[1-9][0-9]*)$/) return 0
      }
      return 1
    }

    function parse_version(tag,    version, main, core, plus_at, dash_at, count) {
      if (substr(tag, 1, 1) != "v") return 0
      version = substr(tag, 2)
      main = version
      parsed_build = ""
      plus_at = index(main, "+")
      if (plus_at > 0) {
        parsed_build = substr(main, plus_at + 1)
        main = substr(main, 1, plus_at - 1)
        if (!valid_identifiers(parsed_build, 0)) return 0
      }

      parsed_prerelease = ""
      dash_at = index(main, "-")
      if (dash_at > 0) {
        parsed_prerelease = substr(main, dash_at + 1)
        main = substr(main, 1, dash_at - 1)
        if (!valid_identifiers(parsed_prerelease, 1)) return 0
      }

      count = split(main, core, ".")
      if (count != 3) return 0
      if (!valid_core_number(core[1]) || !valid_core_number(core[2]) || !valid_core_number(core[3])) return 0

      parsed_tag = tag
      parsed_major = core[1]
      parsed_minor = core[2]
      parsed_patch = core[3]
      return 1
    }

    function compare_decimal(left, right,    index_, left_digit, right_digit) {
      if (length(left) != length(right)) return length(left) > length(right) ? 1 : -1
      for (index_ = 1; index_ <= length(left); index_++) {
        left_digit = substr(left, index_, 1) + 0
        right_digit = substr(right, index_, 1) + 0
        if (left_digit != right_digit) return left_digit > right_digit ? 1 : -1
      }
      return 0
    }

    function compare_ascii(left, right,    alphabet, limit, index_, left_rank, right_rank) {
      alphabet = "+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
      limit = length(left) < length(right) ? length(left) : length(right)
      for (index_ = 1; index_ <= limit; index_++) {
        left_rank = index(alphabet, substr(left, index_, 1))
        right_rank = index(alphabet, substr(right, index_, 1))
        if (left_rank != right_rank) return left_rank > right_rank ? 1 : -1
      }
      if (length(left) == length(right)) return 0
      return length(left) > length(right) ? 1 : -1
    }

    function compare_prerelease(left, right,    left_count, right_count, limit, index_, comparison, left_numeric, right_numeric, left_ids, right_ids) {
      if (left == "" || right == "") {
        if (left == right) return 0
        return left == "" ? 1 : -1
      }

      left_count = split(left, left_ids, ".")
      right_count = split(right, right_ids, ".")
      limit = left_count < right_count ? left_count : right_count
      for (index_ = 1; index_ <= limit; index_++) {
        left_numeric = left_ids[index_] ~ /^[0-9]+$/
        right_numeric = right_ids[index_] ~ /^[0-9]+$/
        if (left_numeric && right_numeric) {
          comparison = compare_decimal(left_ids[index_], right_ids[index_])
        } else if (left_numeric != right_numeric) {
          comparison = left_numeric ? -1 : 1
        } else {
          comparison = compare_ascii(left_ids[index_], right_ids[index_])
        }
        if (comparison != 0) return comparison
      }

      if (left_count == right_count) return 0
      return left_count > right_count ? 1 : -1
    }

    function candidate_is_higher(    comparison) {
      comparison = compare_decimal(parsed_major, best_major)
      if (comparison != 0) return comparison > 0
      comparison = compare_decimal(parsed_minor, best_minor)
      if (comparison != 0) return comparison > 0
      comparison = compare_decimal(parsed_patch, best_patch)
      if (comparison != 0) return comparison > 0
      comparison = compare_prerelease(parsed_prerelease, best_prerelease)
      if (comparison != 0) return comparison > 0
      return compare_ascii(parsed_tag, best_tag) > 0
    }

    function increment_decimal(value,    index_, digit, output) {
      output = ""
      for (index_ = length(value); index_ >= 1; index_--) {
        digit = substr(value, index_, 1) + 0
        if (digit < 9) return substr(value, 1, index_ - 1) (digit + 1) output
        output = "0" output
      }
      return "1" output
    }

    parse_version($0) {
      if (mode == "history") {
        printf "%s\t%s\t%s\n", parsed_major, parsed_minor, parsed_patch
        next
      }

      if (!have_best || candidate_is_higher()) {
        have_best = 1
        best_tag = parsed_tag
        best_major = parsed_major
        best_minor = parsed_minor
        best_patch = parsed_patch
        best_prerelease = parsed_prerelease
      }
    }

    END {
      if (mode == "history") exit
      if (!have_best) {
        best_tag = "-"
        best_major = "0"
        best_minor = "1"
        best_patch = "0"
      }
      printf "%s\t%s\t%s\t%s\t%s\n", best_tag, best_major, best_minor, best_patch, increment_decimal(best_patch)
    }
  '
}

selection="$(git tag --list 'v*' | parse_semver_tags select)"
previous_ifs="$IFS"
IFS="$(printf '\t')" read -r selected_tag major minor patch next_patch <<EOF
$selection
EOF
IFS="$previous_ifs"

current_version="$major.$minor.$patch"
if [ "$selected_tag" = "-" ]; then
  version_source="compatibility default"
  version_milestone="$current_version"
else
  version_source="git tag $selected_tag"
  version_milestone="$major.$minor.$next_patch"
fi

line_milestone="$major.$minor.x"

echo "Detected version baseline: $current_version"
echo "Version baseline source: $version_source"
echo "Line milestone: $line_milestone"
echo "Next version milestone: $version_milestone"

repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"

gh api "repos/$repo/milestones?state=all" --paginate \
  --jq '.[] | [.title, .state] | @tsv' > "$tmpdir/existing.tsv"

cut -f1 "$tmpdir/existing.tsv" > "$tmpdir/existing-titles.txt"
echo "Existing milestones:"
cat "$tmpdir/existing.tsv"

cat <<EOF > "$tmpdir/desired.tsv"
General Backlog	All unsorted backlogged tasks may be completed in a future version.	open
$line_milestone	Issues that we want to resolve in $major.$minor line.	open
$version_milestone	Issues that we want to release in v$version_milestone.	open
EOF

if [ "$history_mode" = "true" ]; then
  git tag --list 'v*' | parse_semver_tags history > "$tmpdir/history-versions.tsv"

  if [ ! -s "$tmpdir/history-versions.tsv" ]; then
    echo "No valid SemVer history tags found matching v*; only standard milestones will be created."
  else
    while IFS="$(printf '\t')" read -r h_major h_minor h_patch; do
      printf '%s\t%s\t%s\n' \
        "$h_major.$h_minor.x" \
        "Issues that we want to resolve in $h_major.$h_minor line." \
        "open" >> "$tmpdir/desired.tsv"

      printf '%s\t%s\t%s\n' \
        "$h_major.$h_minor.$h_patch" \
        "Issues that we want to release in v$h_major.$h_minor.$h_patch." \
        "closed" >> "$tmpdir/desired.tsv"
    done < "$tmpdir/history-versions.tsv"
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
echo "- Version baseline source: $version_source"
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
echo "- Without --history, a single version milestone is created based on the detected baseline."

if [ "$history_mode" = "true" ]; then
  echo "- Historical X.Y.Z tags create X.Y.x milestones as open and X.Y.Z milestones as closed."
  echo "- Repositories with many tags may hit the GitHub API rate limit."
fi
