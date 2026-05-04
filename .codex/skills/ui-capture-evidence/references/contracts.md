# UI Capture Evidence Contract

## Inputs

- `issue_id`: Linear issue identifier (for artifact naming and evidence).
- `artifact_type`: `screenshot` or `screencast`.
- `publish_mode`: `inline_comment` or `attachment_only`.
- `target_url`: URL to capture.
- `min_width`: default `1920` for screenshots.
- `min_height`: default `1080` for screencasts.
- `min_duration_seconds`: default `3` for screencasts.

## Output Fields

- `local_path`
- `mime_type`
- `file_size_bytes`
- `width`
- `height`
- `duration_seconds` (video only)
- `upload_ref`
- `publish_ref`
- `verification_status`

## Failure Semantics

- Any failed gate returns non-zero and blocks state transition.
- Missing metadata is a hard failure.
- Publish mismatch (expected URL not found in comment/attachment) is a hard failure.
