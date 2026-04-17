#!/usr/bin/env bash
set -euo pipefail

LIMIT="20"
OFFSET="0"
PROJECT=""
PROJECT_NAME=""
FROM=""
TO=""
INCLUDE_SILENT=""

rawurlencode() {
  local input="${1:-}"
  local output=""
  local i
  local char
  for ((i = 0; i < ${#input}; i++)); do
    char="${input:i:1}"
    case "$char" in
      [a-zA-Z0-9.~_-]) output+="${char}" ;;
      *) printf -v output '%s%%%02X' "$output" "'$char" ;;
    esac
  done
  printf '%s' "$output"
}

append_query() {
  local key="$1"
  local value="$2"
  QUERY_PARTS+=("${key}=$(rawurlencode "$value")")
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="${2:-20}"; shift 2 ;;
    --offset) OFFSET="${2:-0}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --project-name) PROJECT_NAME="${2:-}"; shift 2 ;;
    --from) FROM="${2:-}"; shift 2 ;;
    --to) TO="${2:-}"; shift 2 ;;
    --include-silent) INCLUDE_SILENT="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$PROJECT" && -n "$PROJECT_NAME" ]]; then
  echo "Use either --project or --project-name, not both." >&2
  exit 2
fi

QUERY_PARTS=("limit=${LIMIT}" "offset=${OFFSET}")
[[ -n "$PROJECT" ]] && append_query "project" "$PROJECT"
[[ -n "$PROJECT_NAME" ]] && append_query "project_name" "$PROJECT_NAME"
[[ -n "$FROM" ]] && append_query "from" "$FROM"
[[ -n "$TO" ]] && append_query "to" "$TO"
[[ -n "$INCLUDE_SILENT" ]] && append_query "include_silent" "$INCLUDE_SILENT"
QUERY="$(IFS='&'; echo "${QUERY_PARTS[*]}")"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${DIR}/api_client.sh" GET /diagnostics/workflow/stalled-threads --query "$QUERY"
