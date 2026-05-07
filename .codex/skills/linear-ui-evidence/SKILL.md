---
name: linear-ui-evidence
description: Publish Playwright screenshots and screencasts for UI-affecting Symphony work into Linear issue comments as rendered rich media. Use before moving UI changes from In Progress to Agent Review.
---

# Linear UI Evidence

Use this skill when a Symphony issue has user-visible UI changes and Playwright
screenshots or screencasts need to be published for review.

This workflow is the intentional GraphQL-only exception to routine Linear MCP
operations. Routine issue lookup, comments, and state changes should use Linear
MCP tools when available. UI evidence publication must use this bundled
publisher because it needs private `fileUpload(makePublic:false)`, signed upload
PUTs, rich `bodyData` image/video nodes, and a verification re-read of
`comment.bodyData`.

Do not hand-author dynamic app-server `linear_graphql` calls for screenshots or
screencasts. Capture media locally, then run the publisher script below.

## Required flow

1. Capture local evidence with the `playwright` skill:
   - Use screenshots for changed visual states.
   - Use screencasts for changed interactions.
   - If a UI change does not need one of those media types, state why in the
     handoff.
2. Publish the evidence with the bundled script:

```sh
node .codex/skills/linear-ui-evidence/scripts/publish-linear-ui-evidence.js \
  --issue ABC-123 \
  --summary "Dashboard drilldown UI evidence" \
  --image output/playwright/drilldown.png::"Drilldown with timeline lanes visible" \
  --video output/playwright/drilldown.webm::"Opening the drilldown and inspecting blocker details"
```

3. Confirm the script reports `verification.status: "passed"`.
4. In the Linear handoff comment, include one of:

```md
Review routing: UI review required
UI evidence: published in this Linear issue
```

or:

```md
Review routing: no UI review required
UI evidence: not applicable
```

## Script contract

- `--issue` is required and may be a Linear key such as `ABC-123` or an
  issue id.
- Use repeated `--image path::caption` for `.png` screenshots.
- Use repeated `--video path::caption` for `.webm` or `.mp4` screencasts.
- `--summary` is optional.
- `--comment-id` updates that explicit existing comment; without it, the script
  creates one new evidence comment. The script does not auto-discover old
  evidence comments.
- Existing `LINEAR_API_KEY` wins. If absent, the script loads repo `.env`.

The script uploads media with private Linear `fileUpload(makePublic:false)` and
creates rich `bodyData` `image`/`video` nodes. It must not use Linear
attachments, base64 payloads, raw HTML, public URLs, or local paths as reviewer
evidence.

The script validates inputs before network calls, performs the direct
GraphQL/HTTP upload and comment operations, and fails with typed errors when
upload, comment save, or verification fails. A successful run re-reads
`comment.bodyData` and reports `verification.status: "passed"` only after the
rendered media node counts and sources match the uploaded assets.

## Evidence quality

- Capture at a viewport large enough for review, default `1280x900` or wider
  unless the UI is mobile-specific.
- Use full-page screenshots only when layout context matters; otherwise capture
  the relevant viewport/state without excessive empty space.
- Screencasts should show the changed interaction from start to result, usually
  3-10 seconds.
- Evidence must be readable without zooming: text, controls, and changed UI
  states should be clear.
- If mobile behavior changed, include mobile-width evidence in addition to
  desktop evidence.

Local `output/playwright/*` files are working artifacts. Do not commit them, and
do not delete them unless the user asks.
