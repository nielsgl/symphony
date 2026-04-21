#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/start-project-dashboard.sh <app-repo-path> [--port <port>] [--workflow <path>] [--offline]

Defaults:
  workflow: <app-repo-path>/WORKFLOW.md
  port: 0 (ephemeral; avoids collisions)

Examples:
  scripts/start-project-dashboard.sh ../symphony-todo-app
  scripts/start-project-dashboard.sh ../symphony-todo-app --port 3001
USAGE
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

APP_REPO=""
PORT="0"
WORKFLOW_PATH=""
OFFLINE="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --workflow)
      WORKFLOW_PATH="${2:-}"
      shift 2
      ;;
    --offline)
      OFFLINE="1"
      shift
      ;;
    -* )
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -z "$APP_REPO" ]]; then
        APP_REPO="$1"
        shift
      else
        echo "Unexpected argument: $1" >&2
        usage
        exit 1
      fi
      ;;
  esac

done

if [[ -z "$APP_REPO" ]]; then
  echo "Missing <app-repo-path>." >&2
  usage
  exit 1
fi

APP_REPO="$(cd "$APP_REPO" && pwd)"
if [[ -z "$WORKFLOW_PATH" ]]; then
  WORKFLOW_PATH="$APP_REPO/WORKFLOW.md"
fi

if [[ ! -f "$WORKFLOW_PATH" ]]; then
  echo "Workflow file not found: $WORKFLOW_PATH" >&2
  exit 1
fi

SYMPHONY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CMD=(npm --prefix "$SYMPHONY_ROOT" run start:dashboard --
  --workflow="$WORKFLOW_PATH"
  --port="$PORT"
  --i-understand-that-this-will-be-running-without-the-usual-guardrails)

if [[ "$OFFLINE" == "1" ]]; then
  SYMPHONY_OFFLINE=1 "${CMD[@]}"
else
  "${CMD[@]}"
fi
