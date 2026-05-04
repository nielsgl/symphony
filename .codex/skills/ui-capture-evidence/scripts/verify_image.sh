#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <image_path> <min_width>" >&2
  exit 2
fi

image_path="$1"
min_width="$2"

if [[ ! -f "$image_path" ]]; then
  echo "file_not_found=$image_path" >&2
  exit 1
fi

dims="$(sips -g pixelWidth -g pixelHeight "$image_path")"
width="$(printf '%s\n' "$dims" | awk '/pixelWidth/ {print $2}')"
height="$(printf '%s\n' "$dims" | awk '/pixelHeight/ {print $2}')"
mime_type="$(file --brief --mime-type "$image_path")"
size_bytes="$(wc -c < "$image_path" | tr -d ' ')"

if [[ -z "${width:-}" || -z "${height:-}" ]]; then
  echo "invalid_dimensions=1" >&2
  exit 1
fi

if (( width < min_width )); then
  echo "width_below_minimum=$width" >&2
  exit 1
fi

echo "file_path=$image_path"
echo "mime_type=$mime_type"
echo "file_size_bytes=$size_bytes"
echo "width=$width"
echo "height=$height"
echo "verification_status=pass"
