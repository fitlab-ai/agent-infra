#!/bin/sh

set -e

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/../../../.." && pwd)
WORKSPACE_ROOT="$REPO_ROOT/.agents/workspace"
COMPLETED_DIR="$WORKSPACE_ROOT/completed"
ARCHIVE_DIR="$WORKSPACE_ROOT/archive"
MANIFEST_PATH="$ARCHIVE_DIR/manifest.md"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM

IDS_FILE="$tmpdir/task-ids.txt"
: > "$IDS_FILE"

usage() {
  cat <<'EOF'
Usage: bash .agents/skills/archive-tasks/scripts/archive-tasks.sh [--days N | --before YYYY-MM-DD | TASK-ID...]
EOF
}

trim_value() {
  printf '%s' "$1" | sed "s/^['\"]//; s/['\"]$//"
}

extract_field() {
  task_file="$1"
  field_name="$2"

  awk -v field_name="$field_name" '
    BEGIN {
      frontmatter = 0
    }

    /^---[[:space:]]*$/ {
      frontmatter += 1
      if (frontmatter == 1) {
        next
      }
      exit
    }

    frontmatter == 1 && index($0, field_name ":") == 1 {
      value = $0
      sub("^" field_name ":[[:space:]]*", "", value)
      print value
      exit
    }
  ' "$task_file"
}

extract_completed_at() {
  task_file="$1"
  completed_at=$(extract_field "$task_file" "completed_at")

  if [ -z "$completed_at" ]; then
    completed_at=$(extract_field "$task_file" "updated_at")
  fi

  trim_value "$completed_at"
}

extract_type() {
  trim_value "$(extract_field "$1" "type")"
}

extract_title() {
  title=$(
    awk '
      BEGIN {
        frontmatter = 0
      }

      /^---[[:space:]]*$/ {
        frontmatter += 1
        next
      }

      frontmatter < 2 {
        next
      }

      /^# / {
        sub(/^# /, "")
        print
        exit
      }
    ' "$1"
  )

  printf '%s' "$title" | sed 's/^任务：//; s/^Task: //' | tr '\t\r\n' '   ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//; s/|/\\|/g'
}

is_valid_date() {
  case "$1" in
    ????-??-??)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

date_to_int() {
  printf '%s' "$1" | tr -d '-'
}

cutoff_date() {
  days="$1"

  if date -v-"$days"d "+%Y-%m-%d" >/dev/null 2>&1; then
    date -v-"$days"d "+%Y-%m-%d"
    return 0
  fi

  date -d "$days days ago" "+%Y-%m-%d"
}

find_archived_task_dir() {
  task_id="$1"

  for year_dir in "$ARCHIVE_DIR"/[0-9][0-9][0-9][0-9]; do
    [ -d "$year_dir" ] || continue

    for month_dir in "$year_dir"/[0-9][0-9]; do
      [ -d "$month_dir" ] || continue

      for day_dir in "$month_dir"/[0-9][0-9]; do
        [ -d "$day_dir" ] || continue

        archived_dir="$day_dir/$task_id"
        if [ -d "$archived_dir" ]; then
          printf '%s\n' "$archived_dir"
          return 0
        fi
      done
    done
  done

  return 1
}

log_skip() {
  task_id="$1"
  reason="$2"
  skipped_count=$((skipped_count + 1))
  printf 'Skipped %s (%s)\n' "$task_id" "$reason"
}

archive_task_dir() {
  task_dir="$1"
  task_id=$(basename "$task_dir")
  task_file="$task_dir/task.md"

  if [ ! -f "$task_file" ]; then
    log_skip "$task_id" "missing task.md"
    return 0
  fi

  completed_at=$(extract_completed_at "$task_file")
  task_date=$(printf '%s' "$completed_at" | cut -c1-10)

  if ! is_valid_date "$task_date"; then
    log_skip "$task_id" "missing completed_at/updated_at date"
    return 0
  fi

  year=$(printf '%s' "$task_date" | cut -c1-4)
  month=$(printf '%s' "$task_date" | cut -c6-7)
  day=$(printf '%s' "$task_date" | cut -c9-10)
  destination_dir="$ARCHIVE_DIR/$year/$month/$day/$task_id"
  relative_path="$year/$month/$day/$task_id/"

  if [ -d "$destination_dir" ]; then
    log_skip "$task_id" "already archived at $relative_path"
    return 0
  fi

  mkdir -p "$ARCHIVE_DIR/$year/$month/$day"
  mv "$task_dir" "$destination_dir"
  archived_count=$((archived_count + 1))
  printf 'Archived %s -> %s\n' "$task_id" "$relative_path"
}

should_archive_filtered_task() {
  task_dir="$1"
  task_file="$task_dir/task.md"

  if [ ! -f "$task_file" ]; then
    return 0
  fi

  completed_at=$(extract_completed_at "$task_file")
  task_date=$(printf '%s' "$completed_at" | cut -c1-10)

  if ! is_valid_date "$task_date"; then
    return 0
  fi

  task_value=$(date_to_int "$task_date")
  cutoff_value=$(date_to_int "$FILTER_DATE")

  [ "$task_value" -lt "$cutoff_value" ]
}

rebuild_manifest() {
  entries_file="$tmpdir/manifest.tsv"
  generated_at=$(date "+%Y-%m-%d %H:%M:%S")

  mkdir -p "$ARCHIVE_DIR"
  : > "$entries_file"

  for year_dir in "$ARCHIVE_DIR"/[0-9][0-9][0-9][0-9]; do
    [ -d "$year_dir" ] || continue
    year=$(basename "$year_dir")

    for month_dir in "$year_dir"/[0-9][0-9]; do
      [ -d "$month_dir" ] || continue
      month=$(basename "$month_dir")

      for day_dir in "$month_dir"/[0-9][0-9]; do
        [ -d "$day_dir" ] || continue
        day=$(basename "$day_dir")

        for task_dir in "$day_dir"/TASK-*; do
          [ -d "$task_dir" ] || continue

          task_id=$(basename "$task_dir")
          task_file="$task_dir/task.md"
          relative_path="$year/$month/$day/$task_id/"
          title="$task_id"
          task_type="unknown"
          completed_at="$year-$month-$day"

          if [ -f "$task_file" ]; then
            file_completed_at=$(extract_completed_at "$task_file")
            file_type=$(extract_type "$task_file")
            file_title=$(extract_title "$task_file")

            if [ -n "$file_completed_at" ]; then
              completed_at="$file_completed_at"
            fi

            if [ -n "$file_type" ]; then
              task_type="$file_type"
            fi

            if [ -n "$file_title" ]; then
              title="$file_title"
            fi
          fi

          printf '%s\t%s\t%s\t%s\t%s\n' "$completed_at" "$task_id" "$title" "$task_type" "$relative_path" >> "$entries_file"
        done
      done
    done
  done

  {
    echo "# Archive Manifest"
    echo
    echo "> Auto-generated by archive-tasks. Do not edit manually."
    echo "> Last updated: $generated_at"
    echo
    echo "| Task ID | Title | Type | Completed | Path |"
    echo "| --- | --- | --- | --- | --- |"

    if [ -s "$entries_file" ]; then
      LC_ALL=C sort -r "$entries_file" | while IFS="$(printf '\t')" read -r completed_at task_id title task_type relative_path; do
        printf '| %s | %s | %s | %s | %s |\n' "$task_id" "$title" "$task_type" "$completed_at" "$relative_path"
      done
    fi
  } > "$MANIFEST_PATH"
}

if [ ! -d "$COMPLETED_DIR" ]; then
  echo "Completed task directory not found: $COMPLETED_DIR"
  exit 1
fi

MODE="all"
FILTER_DATE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --days)
      if [ "$MODE" != "all" ] || [ -s "$IDS_FILE" ]; then
        echo "Cannot combine --days with other filters or task IDs"
        exit 1
      fi

      if [ -z "${2:-}" ]; then
        echo "Missing value for --days"
        exit 1
      fi

      case "$2" in
        ''|*[!0-9]*)
          echo "--days expects a non-negative integer"
          exit 1
          ;;
      esac

      FILTER_DATE=$(cutoff_date "$2")
      MODE="days"
      shift 2
      ;;
    --before)
      if [ "$MODE" != "all" ] || [ -s "$IDS_FILE" ]; then
        echo "Cannot combine --before with other filters or task IDs"
        exit 1
      fi

      if [ -z "${2:-}" ]; then
        echo "Missing value for --before"
        exit 1
      fi

      if ! is_valid_date "$2"; then
        echo "--before expects a date in YYYY-MM-DD format"
        exit 1
      fi

      FILTER_DATE="$2"
      MODE="before"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
    *)
      printf '%s\n' "$1" >> "$IDS_FILE"
      shift
      ;;
  esac
done

if [ -s "$IDS_FILE" ]; then
  if [ "$MODE" != "all" ]; then
    echo "Cannot combine task IDs with --days or --before"
    exit 1
  fi

  MODE="ids"
fi

archived_count=0
skipped_count=0

case "$MODE" in
  all)
    for task_dir in "$COMPLETED_DIR"/TASK-*; do
      [ -d "$task_dir" ] || continue
      archive_task_dir "$task_dir"
    done
    ;;
  days|before)
    for task_dir in "$COMPLETED_DIR"/TASK-*; do
      [ -d "$task_dir" ] || continue

      if should_archive_filtered_task "$task_dir"; then
        archive_task_dir "$task_dir"
      fi
    done
    ;;
  ids)
    while IFS= read -r task_id; do
      [ -n "$task_id" ] || continue
      task_dir="$COMPLETED_DIR/$task_id"

      if [ -d "$task_dir" ]; then
        archive_task_dir "$task_dir"
        continue
      fi

      archived_dir=$(find_archived_task_dir "$task_id" || true)
      if [ -n "$archived_dir" ]; then
        relative_path=${archived_dir#"$ARCHIVE_DIR"/}
        log_skip "$task_id" "already archived at $relative_path/"
        continue
      fi

      log_skip "$task_id" "not found in completed/"
    done < "$IDS_FILE"
    ;;
esac

rebuild_manifest

echo
echo "Summary:"
printf -- '- Archived: %s\n' "$archived_count"
printf -- '- Skipped: %s\n' "$skipped_count"
printf -- '- Manifest: %s\n' ".agents/workspace/archive/manifest.md"
