---
name: ui-capture-evidence
description: Capture, validate, and publish high-quality UI screenshots and screencasts with deterministic artifact selection and verification evidence. Use when tasks require screenshot/screencast artifacts for reviews, issue updates, or acceptance proof in Linear.
---

# UI Capture Evidence

Use this skill to produce deterministic, review-quality UI artifacts.

## Workflow

1. Resolve the target URL and verify it is reachable before capture.
2. Create a run-scoped output directory under `output/playwright/`.
3. Capture artifact(s):
   - Screenshot: PNG, full-page when relevant.
   - Screencast: WebM/MP4 as requested.
4. Select the candidate artifact from the current run only:
   - Use `scripts/select_best_artifact.sh`.
   - If multiple candidates exist, pick the highest resolution by pixel area.
5. Enforce quality gates before upload:
   - Screenshot width must be at least 1920.
   - Screencast must satisfy minimum width/height and minimum duration.
   - Use `scripts/verify_image.sh` or `scripts/verify_video.sh`.
6. Upload the selected artifact to Linear.
7. Verify publish result:
   - `inline_comment` mode: comment contains `![title](url)` and URL is the uploaded asset URL.
   - `attachment_only` mode: issue contains the expected attachment URL/title.
8. Record evidence in the workpad using the required fields.

## Required Evidence Fields

Include these keys in the workpad `Artifact Evidence` section:

- `artifact_type`
- `publish_mode`
- `local_path`
- `mime_type`
- `file_size_bytes`
- `width` / `height` (or video resolution + duration)
- `upload_ref` (attachment id or asset url)
- `publish_ref` (comment id/url or attachment id)
- `verification_status` (`pass`/`fail`)

## Commands

Select best artifact:

```bash
scripts/select_best_artifact.sh output/playwright NIE-31 screenshot png
```

Verify screenshot:

```bash
scripts/verify_image.sh output/playwright/NIE-31-20260504T100000Z-screenshot.png 1920
```

Verify screencast:

```bash
scripts/verify_video.sh output/playwright/NIE-31-20260504T100000Z-screencast.webm 1920 1080 3
```

## Failure Policy

Fail closed. Do not publish artifacts and do not move issue state forward if any validation or publish verification fails.
