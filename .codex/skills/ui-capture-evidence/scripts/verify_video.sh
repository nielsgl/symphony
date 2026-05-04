#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <video_path> <min_width> <min_height> <min_duration_seconds>" >&2
  exit 2
fi

video_path="$1"
min_width="$2"
min_height="$3"
min_duration="$4"

if [[ ! -f "$video_path" ]]; then
  echo "file_not_found=$video_path" >&2
  exit 1
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "tool_missing=ffprobe" >&2
  exit 1
fi

meta="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -of default=noprint_wrappers=1 "$video_path")"
width="$(printf '%s\n' "$meta" | awk -F= '/^width=/{print $2}' | head -n1)"
height="$(printf '%s\n' "$meta" | awk -F= '/^height=/{print $2}' | head -n1)"
duration="$(printf '%s\n' "$meta" | awk -F= '/^duration=/{print $2}' | head -n1)"
mime_type="$(file --brief --mime-type "$video_path")"
size_bytes="$(wc -c < "$video_path" | tr -d ' ')"

if [[ -z "${width:-}" || -z "${height:-}" || -z "${duration:-}" ]]; then
  echo "invalid_video_metadata=1" >&2
  exit 1
fi

if (( width < min_width )); then
  echo "width_below_minimum=$width" >&2
  exit 1
fi

if (( height < min_height )); then
  echo "height_below_minimum=$height" >&2
  exit 1
fi

duration_floor="${duration%.*}"
if (( duration_floor < min_duration )); then
  echo "duration_below_minimum=$duration" >&2
  exit 1
fi

echo "file_path=$video_path"
echo "mime_type=$mime_type"
echo "file_size_bytes=$size_bytes"
echo "width=$width"
echo "height=$height"
echo "duration_seconds=$duration"
echo "verification_status=pass"
