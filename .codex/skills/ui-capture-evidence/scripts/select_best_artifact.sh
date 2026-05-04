#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <dir> <issue_id> <artifact_kind> <ext>" >&2
  exit 2
fi

dir="$1"
issue_id="$2"
artifact_kind="$3"
ext="$4"
issue_id_lc="$(printf '%s' "$issue_id" | tr '[:upper:]' '[:lower:]')"

if [[ ! -d "$dir" ]]; then
  echo "directory_not_found=$dir" >&2
  exit 1
fi

best_file=""
best_area=0

shopt -s nullglob
for file in "$dir"/*.${ext}; do
  base="$(basename "$file")"
  base_lc="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')"
  if [[ "$base_lc" != ${issue_id_lc}-* ]]; then
    continue
  fi
  if [[ "$base_lc" != *"${artifact_kind}"* ]]; then
    continue
  fi
  dims="$(sips -g pixelWidth -g pixelHeight "$file" 2>/dev/null || true)"
  width="$(printf '%s\n' "$dims" | awk '/pixelWidth/ {print $2}')"
  height="$(printf '%s\n' "$dims" | awk '/pixelHeight/ {print $2}')"
  if [[ -z "${width:-}" || -z "${height:-}" ]]; then
    continue
  fi
  area=$((width * height))
  if (( area > best_area )); then
    best_area="$area"
    best_file="$file"
  fi
done

if [[ -z "$best_file" ]]; then
  echo "no_matching_artifact=1" >&2
  exit 1
fi

echo "selected_file=$best_file"
echo "selected_area=$best_area"
