# Living Agent Lens — Evidence Reproducibility

This doc explains how to regenerate visual proof for the Living Agent Lens
implementation (the `/lens` route + the `GET /api/v1/living-agent-lens`
projection). The generated artifacts (PNG, WebM, HTML) are intentionally
**not** committed to the repository. They land under a gitignored path so
each reviewer can produce them locally without bloating git history.

The Lens implementation itself is described in
[`living-agent-lens-ultimate-design-spec.md`](./living-agent-lens-ultimate-design-spec.md).

## Where evidence is written

All capture scripts write to:

```
output/playwright/living-agent-lens/
```

`output/playwright/` is already covered by [`.gitignore`](../../.gitignore).
Nothing under this path should ever be staged. If `git status` shows PNG,
WebM, or HTML files in a `docs/` subtree, it is a bug — move the script's
output path back under `output/playwright/`.

## What proof is expected

A full evidence run produces three artifact families:

| Family | Source | Expected files |
|---|---|---|
| **Pass 1 — Empty-state live** | Real `npm run start:dashboard` with `SYMPHONY_OFFLINE=1` (no Linear issues claimed). Documents the honest "No active work" projection. | `live-*-desktop-1586x992.png`, `*-medium-1440x1000.png`, `*-small-1280x900.png`, `*-mobile-680x1000.png`, `*-reduced-motion-1586x992.png` |
| **Pass 2 — Focused live** | `LocalApiServer` booted directly with a synthetic `OrchestratorState` containing running + retrying + blocked-input entries. Exercises the focus crown, queue ordering, interlock spine, and connector layer. | `live-*-focused-*.png` (5 viewports) + `live-motion-*.webm` (20-second motion capture) |
| **Pass 3 — Fixture preview** *(iteration only)* | `lens-preview.html` stubs `fetch('/api/v1/living-agent-lens')` so geometry/animation can be iterated without booting the runtime. Not product evidence. | `*-<slug>-<w>x<h>.png`, `lens-preview.html` |

The 20-second motion capture (Pass 2) is the proof for the spec's "Shipping
static beauty" rejection gate: orbit phase must remain continuous through a
real `POST /api/v1/refresh` and through focus changes.

## How to reproduce

```sh
# Make sure dist/ is current — the live scripts require dist/src/api.
npm run build

# Pass 1 — empty-state live route
SYMPHONY_OFFLINE=1 node scripts/start-dashboard.js \
  --port=61029 \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails &
until curl -fsS http://127.0.0.1:61029/api/v1/state >/dev/null; do sleep 1; done
node scripts/screenshot-live-lens.js http://127.0.0.1:61029
lsof -ti:61029 | xargs -r kill -9

# Pass 2 — focused live route + 20-second motion video
node scripts/capture-live-lens-evidence.js

# Pass 3 — fixture iteration only
node scripts/build-lens-preview.js
node scripts/screenshot-lens.js desktop 1586 992
```

Outputs land under `output/playwright/living-agent-lens/`. Inspect with any
image viewer; the WebM file plays in any modern browser or `ffplay`.

## Accepted gaps

Every Living Agent Lens response includes a `missing_capabilities[]` array
that the UI surfaces in the "Honest Gaps" chip. These are not bugs in the
projector — they are deliberate, structured markers that the backend has not
yet implemented a particular signal. The most relevant gaps for evidence
review:

- `gravity_score` — projector-computed; spec asks for orchestrator-authored.
- `command_preview` — request previews use real route contracts but the
  reason-note / answer text are operator-supplied at submit time; severity
  `visual_only` when shape matches, `blocks_action` when no real route
  exists.
- `evidence_path_receipts` — audit cell derives a receipt id from
  `operator_actions[]`; `GET /api/v1/audit/receipts/:receiptId` is not yet
  implemented.
- `transcript_open_endpoint` — `/api/v1/sessions/:id/rollout` does not
  exist; transcript pill is informational only (amber, no `open_endpoint`).
- `bounded_window`, `role_stream_window`, `event_orbit`,
  `transcript_confidence` — refinements to the live lens projection.
- `tracker_title_projection` — the snapshot service does not yet propagate
  the Linear issue title onto running/retrying/blocked entries, so the
  focus crown falls back to `last_message`.
- `audit_recording_proof` — emitted only when no `auditHealth` is supplied
  to the projector; when present, the Audit cell renders `Unknown` (amber)
  instead of `Recording` (red).
- `shell_smart_filters` — the Filters button is disabled until a real
  smart-filter panel + apply route exists.
- `action_dock_more` — secondary `More` menu items link to existing API
  surfaces; a designed secondary panel is not yet implemented.

When reviewing evidence captures, the "Honest Gaps" chip should never show
**0** for a populated state: any backend signal the projector cannot prove
is required to surface here.

## Visual acceptance bar

For each viewport in Pass 1 and Pass 2:

- Lens stays circular (`aspect-ratio: 1 / 1`); no ovalization on resize.
- Three-column layout intact above 1280px width; collapses cleanly at
  smaller widths.
- Connector curves terminate at real visible nodes (queue dot → lens
  intake, lens output → spine, lens junction → evidence rail).
- Refresh pulse is a box-shadow-only animation; the surrounding cells must
  not shift.
- No green checkmarks or green evidence pills without a backing field.
- Disabled action-dock buttons + the Filters button show a hover/title
  reason and never appear active.
- No fake macOS traffic-light dots in the header chrome.

For the 20-second motion capture (Pass 2):

- Orbit nodes do **not** snap to a start position after the
  `POST /api/v1/refresh` halfway through the capture.
- Focus crossfade between queue rows does not remount the lens (rings,
  star field, breathing animation must remain continuous).
- Reduced-motion variant (rerun the capture with `reducedMotion: 'reduce'`
  in the Playwright context) freezes orbit positions but preserves state
  colour and hover/click affordances.

## What is intentionally not in this repo

- Pre-captured PNG / WebM screenshots and motion clips.
- The `lens-preview.html` fixture harness.
- Any binary asset under `docs/`.

If you need to share evidence with a reviewer, upload the captures from
`output/playwright/living-agent-lens/` to the relevant Linear comment via
the `linear-ui-evidence` skill — that is the canonical channel for visual
proof, not the git repository.
