#!/usr/bin/env bash
set -euo pipefail

METHOD="${1:-GET}"
PATH_ARG="${2:-/health}"
shift $(( $# > 0 ? 1 : 0 )) || true
shift $(( $# > 0 ? 1 : 0 )) || true

QUERY=""
DATA=""
DATA_FILE=""
RAW="false"
TIMEOUT="${CODEX_API_TIMEOUT_SECONDS:-30}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --query)
      QUERY="${2:-}"
      shift 2
      ;;
    --data)
      DATA="${2:-}"
      shift 2
      ;;
    --data-file)
      DATA_FILE="${2:-}"
      shift 2
      ;;
    --raw)
      RAW="true"
      shift
      ;;
    --timeout-seconds)
      TIMEOUT="${2:-30}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

SCHEME="${CODEX_API_SCHEME:-http}"
HOST="${CODEX_API_HOST:-127.0.0.1}"
PORT="${CODEX_API_PORT:-18731}"
BASE_PATH="${CODEX_API_BASE_PATH:-/api}"
API_KEY="${CODEX_API_KEY:-}"

if [[ "$PATH_ARG" != /* ]]; then
  PATH_ARG="/$PATH_ARG"
fi

if [[ "$BASE_PATH" != /* ]]; then
  BASE_PATH="/$BASE_PATH"
fi

URL="${SCHEME}://${HOST}:${PORT}${BASE_PATH}${PATH_ARG}"
if [[ -n "$QUERY" ]]; then
  URL="${URL}?${QUERY}"
fi

TMP_BODY="$(mktemp)"
trap 'rm -f "$TMP_BODY"' EXIT

CURL_ARGS=(
  -sS
  -X "$METHOD"
  --connect-timeout 5
  --max-time "$TIMEOUT"
  -H "Accept: application/json"
  -o "$TMP_BODY"
  -w "%{http_code}"
)

if [[ -n "$API_KEY" ]]; then
  CURL_ARGS+=( -H "Authorization: Bearer ${API_KEY}" )
fi

if [[ -n "$DATA" ]]; then
  CURL_ARGS+=( -H "Content-Type: application/json" --data "$DATA" )
elif [[ -n "$DATA_FILE" ]]; then
  CURL_ARGS+=( -H "Content-Type: application/json" --data-binary "@${DATA_FILE}" )
fi

set +e
HTTP_CODE="$(curl "${CURL_ARGS[@]}" "$URL")"
CURL_EXIT=$?
set -e

if [[ $CURL_EXIT -ne 0 ]]; then
  echo "Request failed for ${METHOD} ${URL}" >&2
  exit $CURL_EXIT
fi

if [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; then
  if [[ "$RAW" == "true" ]]; then
    cat "$TMP_BODY"
    exit 0
  fi

  if command -v jq >/dev/null 2>&1; then
    jq . "$TMP_BODY"
  else
    cat "$TMP_BODY"
  fi
  exit 0
fi

echo "HTTP ${HTTP_CODE} for ${METHOD} ${URL}" >&2
if command -v jq >/dev/null 2>&1; then
  jq . "$TMP_BODY" >&2 || cat "$TMP_BODY" >&2
else
  cat "$TMP_BODY" >&2
fi
exit 1
