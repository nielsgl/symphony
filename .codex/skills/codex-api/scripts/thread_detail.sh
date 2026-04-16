#!/usr/bin/env bash
set -euo pipefail

THREAD_ID="${1:-}"
if [[ -z "$THREAD_ID" ]]; then
  echo "Usage: $0 THREAD_ID [--include-unredacted true|false] [--include-silent true|false]" >&2
  exit 2
fi
shift

INCLUDE_UNREDACTED=""
INCLUDE_SILENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --include-unredacted) INCLUDE_UNREDACTED="${2:-}"; shift 2 ;;
    --include-silent) INCLUDE_SILENT="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

QUERY_PARTS=()
[[ -n "$INCLUDE_UNREDACTED" ]] && QUERY_PARTS+=("include_unredacted=${INCLUDE_UNREDACTED}")
[[ -n "$INCLUDE_SILENT" ]] && QUERY_PARTS+=("include_silent=${INCLUDE_SILENT}")

QUERY=""
if [[ ${#QUERY_PARTS[@]} -gt 0 ]]; then
  QUERY="$(IFS='&'; echo "${QUERY_PARTS[*]}")"
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATH_ARG="/threads/${THREAD_ID}"
if [[ -n "$QUERY" ]]; then
  "${DIR}/api_client.sh" GET "$PATH_ARG" --query "$QUERY"
else
  "${DIR}/api_client.sh" GET "$PATH_ARG"
fi
