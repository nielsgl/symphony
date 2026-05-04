# Linear Publish Rules

## Inline Comment Mode

Use when artifact must be review-visible in-thread.

Required:
- Comment body includes markdown image/video link using uploaded URL.
- URL in comment must match uploaded asset URL.
- Capture comment ID for `publish_ref`.

## Attachment-Only Mode

Use when issue-level attachment is sufficient.

Required:
- Attachment exists on issue with expected URL and title.
- Capture attachment ID for `publish_ref`.

## Verification Checklist

1. Upload succeeds (`2xx` for signed upload URL or Linear attachment API success).
2. Uploaded URL resolves and has expected mime/dimensions metadata.
3. Publish destination contains that same URL.
