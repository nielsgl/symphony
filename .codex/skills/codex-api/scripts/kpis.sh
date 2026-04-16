#!/usr/bin/env bash
set -euo pipefail

FROM=""
TO=""
PROJECT=""
INCLUDE_SILENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2 ;;
    --to) TO="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --include-silent) INCLUDE_SILENT="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

QUERY_PARTS=()
[[ -n "$FROM" ]] && QUERY_PARTS+=("from=${FROM}")
[[ -n "$TO" ]] && QUERY_PARTS+=("to=${TO}")
[[ -n "$PROJECT" ]] && QUERY_PARTS+=("project=${PROJECT}")
[[ -n "$INCLUDE_SILENT" ]] && QUERY_PARTS+=("include_silent=${INCLUDE_SILENT}")

QUERY=""
if [[ ${#QUERY_PARTS[@]} -gt 0 ]]; then
  QUERY="$(IFS='&'; echo "${QUERY_PARTS[*]}")"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "$QUERY" ]]; then
  "${DIR}/api_client.sh" GET /kpis --query "$QUERY"
else
  "${DIR}/api_client.sh" GET /kpis
fi
