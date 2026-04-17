#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/project_threads.sh <PROJECT_ID> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--sort cost|tokens|updated] [--include-silent true|false] [--limit N] [--offset N]" >&2
  exit 2
fi

PROJECT_ID="$1"
shift

FROM=""
TO=""
SORT=""
INCLUDE_SILENT=""
LIMIT=""
OFFSET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2 ;;
    --to) TO="${2:-}"; shift 2 ;;
    --sort) SORT="${2:-}"; shift 2 ;;
    --include-silent) INCLUDE_SILENT="${2:-}"; shift 2 ;;
    --limit) LIMIT="${2:-}"; shift 2 ;;
    --offset) OFFSET="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

QUERY_PARTS=()
[[ -n "$FROM" ]] && QUERY_PARTS+=("from=${FROM}")
[[ -n "$TO" ]] && QUERY_PARTS+=("to=${TO}")
[[ -n "$SORT" ]] && QUERY_PARTS+=("sort=${SORT}")
[[ -n "$INCLUDE_SILENT" ]] && QUERY_PARTS+=("include_silent=${INCLUDE_SILENT}")
[[ -n "$LIMIT" ]] && QUERY_PARTS+=("limit=${LIMIT}")
[[ -n "$OFFSET" ]] && QUERY_PARTS+=("offset=${OFFSET}")

QUERY=""
if [[ ${#QUERY_PARTS[@]} -gt 0 ]]; then
  QUERY="$(IFS='&'; echo "${QUERY_PARTS[*]}")"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATH_ARG="/projects/${PROJECT_ID}/threads"
if [[ -n "$QUERY" ]]; then
  "${DIR}/api_client.sh" GET "${PATH_ARG}" --query "$QUERY"
else
  "${DIR}/api_client.sh" GET "${PATH_ARG}"
fi
