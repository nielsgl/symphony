# Examples

## Screenshot, inline comment

1. Capture to:
   - `output/playwright/NIE-31-20260504T093300Z-screenshot.png`
2. Verify:
   - `scripts/verify_image.sh <path> 1920`
3. Publish:
   - Upload and create Linear comment containing:
     - `![NIE-31 screenshot](https://public.linear.app/...png)`
4. Record evidence fields in workpad.

## Screenshot, attachment only

1. Capture + verify as above.
2. Attach URL to issue attachment list.
3. Record attachment ID in `publish_ref`.

## Screencast

1. Capture to:
   - `output/playwright/NIE-31-20260504T093300Z-screencast.webm`
2. Verify:
   - `scripts/verify_video.sh <path> 1920 1080 3`
3. Upload + publish.
4. Record duration and resolution in evidence.
