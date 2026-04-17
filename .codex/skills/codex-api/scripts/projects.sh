#!/usr/bin/env bash
set -euo pipefail

LIMIT=""
OFFSET=""
INCLUDE_SILENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="${2:-}"; shift 2 ;;
    --offset) OFFSET="${2:-}"; shift 2 ;;
    --include-silent) INCLUDE_SILENT="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

QUERY_PARTS=()
[[ -n "$LIMIT" ]] && QUERY_PARTS+=("limit=${LIMIT}")
[[ -n "$OFFSET" ]] && QUERY_PARTS+=("offset=${OFFSET}")
[[ -n "$INCLUDE_SILENT" ]] && QUERY_PARTS+=("include_silent=${INCLUDE_SILENT}")

QUERY=""
if [[ ${#QUERY_PARTS[@]} -gt 0 ]]; then
  QUERY="$(IFS='&'; echo "${QUERY_PARTS[*]}")"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "$QUERY" ]]; then
  "${DIR}/api_client.sh" GET /projects --query "$QUERY"
else
  "${DIR}/api_client.sh" GET /projects
fi
