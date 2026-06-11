// Living Agent Lens stylesheet. Implements the spec's design tokens and the
// fixed three-column geometry from the source image. Single source of truth
// for visuals; no inline styles in the client TS.

export function renderLensStylesCss(): string {
  return CSS;
}

const CSS = String.raw`
/* =========================================================================
 * Tokens
 * =========================================================================*/
:root {
  --lens-shell-bg: #02070b;
  --lens-deep-surface: rgba(5, 17, 26, 0.82);
  --lens-raised-surface: rgba(9, 25, 37, 0.88);
  --lens-hairline: rgba(130, 180, 220, 0.20);
  --lens-blue: #5aaeff;
  --lens-electric: #57aaff;
  --lens-cyan: #5ecbff;
  --lens-green: #8af59b;
  --lens-audit-green: #74f48d;
  --lens-amber: #ffc35c;
  --lens-orange: #ffad4f;
  --lens-red: #ff6f63;
  --lens-violet: #b69bff;
  --lens-text: #eaf6ff;
  --lens-text-secondary: #b7c7d5;
  --lens-text-muted: #86a0b4;
  --lens-text-disabled: #587083;
  --lens-radius-shell: 22px;
  --lens-radius-capsule: 26px;
  --lens-radius-card: 20px;
  --lens-radius-pill: 14px;
  --lens-radius-tiny: 10px;
  --lens-shadow-blue: 0 0 60px rgba(90, 174, 255, 0.18), 0 0 140px rgba(90, 174, 255, 0.10);

  color-scheme: dark;
}

/* =========================================================================
 * Reset + shell background
 * =========================================================================*/
*, *::before, *::after { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--lens-shell-bg);
  color: var(--lens-text);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  min-height: 100vh;
  overflow: hidden;
}

body::before {
  /* Subtle radial atmospheric glow behind the entire app. */
  content: '';
  position: fixed;
  inset: 0;
  background:
    radial-gradient(ellipse 70% 60% at 50% 40%, rgba(90, 174, 255, 0.10), transparent 70%),
    radial-gradient(ellipse 60% 50% at 80% 30%, rgba(86, 200, 255, 0.06), transparent 65%),
    radial-gradient(ellipse 60% 50% at 20% 70%, rgba(116, 244, 141, 0.04), transparent 60%);
  pointer-events: none;
  z-index: 0;
}

.hidden { display: none !important; }

button {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid var(--lens-cyan);
  outline-offset: 2px;
  border-radius: 6px;
}
button[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: 0.55;
}

/* =========================================================================
 * App layout — three columns + lower row + footer
 * =========================================================================*/
.lens-app {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-rows: auto auto 1fr auto auto;
  gap: 16px;
  padding: 20px 24px 16px;
  height: 100vh;
  max-width: 1586px;
  margin: 0 auto;
  isolation: isolate;
}

/* =========================================================================
 * Window chrome + telemetry ribbon
 * =========================================================================*/
.lens-shell-header {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lens-shell-header { position: relative; }

.lens-brand { display: flex; flex-direction: column; gap: 2px; padding-left: 4px; }
.lens-brand-title { margin: 0; font-size: 18px; font-weight: 750; letter-spacing: 0.005em; color: var(--lens-text); }
.lens-brand-subtitle { margin: 0; font-size: 12px; color: var(--lens-text-muted); letter-spacing: 0.02em; }

.lens-ribbon {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr)) auto auto;
  gap: 10px;
  padding: 10px 14px;
  background: var(--lens-deep-surface);
  border: 1px solid var(--lens-hairline);
  border-radius: 14px;
  backdrop-filter: blur(12px);
}

.lens-classic-link {
  display: inline-flex;
  align-items: center;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--lens-hairline);
  color: var(--lens-text-secondary);
  text-decoration: none;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  background: transparent;
}
.lens-classic-link:hover { border-color: var(--lens-cyan); color: var(--lens-cyan); background: rgba(94, 203, 255, 0.06); }
.lens-classic-link:focus-visible { outline: 2px solid var(--lens-cyan); outline-offset: 2px; }

.lens-cell {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 12px;
  background: transparent;
  border: 1px solid transparent;
  text-align: left;
  min-width: 0;
  transition: background 200ms ease, border-color 200ms ease;
}
.lens-cell:not([disabled]):hover { background: rgba(255, 255, 255, 0.03); border-color: var(--lens-hairline); }
.lens-cell:not([disabled]) { cursor: pointer; }
.lens-cell[disabled] { cursor: default; }
.lens-cell:not([disabled]):focus-visible { outline: 2px solid var(--lens-cyan); outline-offset: 2px; }
.lens-filters[disabled] { cursor: default; opacity: 0.55; }
.lens-filters[disabled]:hover { background: transparent; border-color: var(--lens-hairline); }
.lens-cell-icon { display: inline-flex; align-items: center; color: var(--lens-cyan); }
.lens-cell[data-tone="green"] .lens-cell-icon { color: var(--lens-green); }
.lens-cell[data-tone="amber"] .lens-cell-icon { color: var(--lens-amber); }
.lens-cell[data-tone="red"] .lens-cell-icon { color: var(--lens-red); }
.lens-cell[data-tone="violet"] .lens-cell-icon { color: var(--lens-violet); }
.lens-cell-text { display: inline-flex; flex-direction: column; min-width: 0; line-height: 1.2; }
.lens-cell-label {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 800;
  color: var(--lens-text-muted);
}
.lens-cell-value {
  font-size: 13px;
  font-weight: 700;
  color: var(--lens-text);
}
.lens-cell-detail {
  font-size: 11px;
  color: var(--lens-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lens-cell[data-cell="audit"] .lens-cell-icon { color: var(--lens-red); animation: lens-audit-blink 2.4s ease-in-out infinite; }
@keyframes lens-audit-blink {
  0%, 100% { opacity: 1; filter: drop-shadow(0 0 4px rgba(255, 111, 99, 0.6)); }
  50% { opacity: 0.55; filter: drop-shadow(0 0 0 rgba(255, 111, 99, 0)); }
}

.lens-cell-pulse {
  animation: lens-cell-pulse-anim 720ms ease-out 1;
}
@keyframes lens-cell-pulse-anim {
  0% { box-shadow: 0 0 0 0 rgba(90, 174, 255, 0.4); }
  100% { box-shadow: 0 0 0 14px rgba(90, 174, 255, 0); }
}

.lens-filters {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid var(--lens-hairline);
  color: var(--lens-text);
  font-weight: 700;
  font-size: 12px;
}
.lens-filters:hover { background: rgba(90, 174, 255, 0.08); border-color: rgba(90, 174, 255, 0.4); }

/* =========================================================================
 * Missing capabilities chip
 * =========================================================================*/
.lens-missing { display: flex; align-items: center; gap: 8px; }
.lens-missing-chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 12px;
  border-radius: 12px;
  border: 1px solid rgba(255, 195, 92, 0.35);
  background: rgba(255, 195, 92, 0.06);
  color: var(--lens-amber);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
}
.lens-missing[data-empty="true"] .lens-missing-chip {
  border-color: rgba(116, 244, 141, 0.3);
  background: rgba(116, 244, 141, 0.05);
  color: var(--lens-audit-green);
}
.lens-missing-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  padding: 0 5px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 999px;
  font-size: 10px;
}
.lens-missing-panel {
  position: absolute;
  z-index: 30;
  margin-top: 6px;
  padding: 14px;
  border-radius: 14px;
  background: var(--lens-raised-surface);
  border: 1px solid var(--lens-hairline);
  max-width: 520px;
  max-height: 360px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: var(--lens-shadow-blue);
}
.lens-missing-item {
  display: flex; flex-direction: column; gap: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--lens-hairline);
}
.lens-missing-item-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.lens-missing-item-label { margin: 0; font-size: 13px; font-weight: 700; color: var(--lens-text); }
.lens-missing-item-tag { font-size: 10px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--lens-amber); }
.lens-missing-item-fallback { margin: 0; font-size: 12px; color: var(--lens-text-secondary); }
.lens-missing-item-hint { margin: 0; font-size: 11px; color: var(--lens-text-muted); }

/* =========================================================================
 * Three-column stage
 * =========================================================================*/
.lens-stage-grid {
  display: grid;
  grid-template-columns: 286px 1fr 332px;
  gap: 20px;
  min-height: 0;
}
.lens-column-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
.lens-eyebrow {
  margin: 0;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--lens-text-muted);
}
.lens-column-title {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  color: var(--lens-text-secondary);
}

/* =========================================================================
 * Notification Gravity Queue
 * =========================================================================*/
.lens-queue-column { display: flex; flex-direction: column; min-height: 0; }
.lens-queue {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  scrollbar-width: thin;
}
.lens-queue-row {
  position: relative;
  display: grid;
  grid-template-columns: 36px 1fr 14px;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--lens-deep-surface);
  border: 1px solid var(--lens-hairline);
  border-radius: var(--lens-radius-capsule);
  cursor: pointer;
  transition: transform 180ms ease, border-color 200ms ease, box-shadow 240ms ease, background 200ms ease;
  min-height: 72px;
}
.lens-queue-row:hover { transform: translateY(-1px); border-color: rgba(90, 174, 255, 0.45); }
.lens-queue-row-focus {
  background: linear-gradient(135deg, rgba(90, 174, 255, 0.12), rgba(94, 203, 255, 0.06));
  border-color: rgba(90, 174, 255, 0.65);
  box-shadow: 0 0 0 1px rgba(90, 174, 255, 0.3), 0 12px 30px rgba(90, 174, 255, 0.18);
}
.lens-queue-row-leaving { opacity: 0; transform: translateY(-4px); pointer-events: none; transition: opacity 280ms ease, transform 280ms ease; }
.lens-queue-row[data-state="blocked"] { border-color: rgba(255, 111, 99, 0.5); }
.lens-queue-row[data-state="warning"], .lens-queue-row[data-state="retry"] { border-color: rgba(255, 195, 92, 0.45); }
.lens-queue-row[data-state="review"] { border-color: rgba(255, 195, 92, 0.55); }

.lens-row-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(90, 174, 255, 0.10);
  color: var(--lens-blue);
}
.lens-queue-row[data-state="blocked"] .lens-row-glyph { background: rgba(255, 111, 99, 0.12); color: var(--lens-red); }
.lens-queue-row[data-state="warning"] .lens-row-glyph,
.lens-queue-row[data-state="retry"] .lens-row-glyph,
.lens-queue-row[data-state="review"] .lens-row-glyph { background: rgba(255, 195, 92, 0.12); color: var(--lens-amber); }
.lens-queue-row-focus .lens-row-glyph { background: rgba(94, 203, 255, 0.18); color: var(--lens-cyan); }

.lens-row-body { display: flex; flex-direction: column; min-width: 0; gap: 3px; }
.lens-row-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.lens-row-id { font-size: 13px; font-weight: 850; letter-spacing: 0.02em; color: var(--lens-text); }
.lens-row-status { font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--lens-text-muted); letter-spacing: 0.08em; }
.lens-queue-row[data-state="blocked"] .lens-row-status { color: var(--lens-red); }
.lens-queue-row[data-state="warning"] .lens-row-status,
.lens-queue-row[data-state="retry"] .lens-row-status,
.lens-queue-row[data-state="review"] .lens-row-status { color: var(--lens-amber); }
.lens-row-title { font-size: 12px; font-weight: 650; color: var(--lens-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lens-row-meta { display: flex; align-items: baseline; gap: 4px; }
.lens-row-score { font-size: 12px; font-weight: 800; color: var(--lens-text); font-variant-numeric: tabular-nums; }
.lens-row-unit { font-size: 9px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: var(--lens-text-muted); }

.lens-row-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--lens-text-disabled);
  align-self: center;
  transition: background 180ms ease, box-shadow 240ms ease;
}
.lens-queue-row:hover .lens-row-dot { background: var(--lens-cyan); box-shadow: 0 0 12px rgba(94, 203, 255, 0.6); }
.lens-queue-row-focus .lens-row-dot { background: var(--lens-cyan); box-shadow: 0 0 18px rgba(94, 203, 255, 0.8); }
.lens-queue-row[data-state="blocked"] .lens-row-dot { background: var(--lens-red); }
.lens-queue-row[data-state="warning"] .lens-row-dot,
.lens-queue-row[data-state="retry"] .lens-row-dot,
.lens-queue-row[data-state="review"] .lens-row-dot { background: var(--lens-amber); }

.lens-row-tooltip {
  position: absolute;
  left: calc(100% + 12px);
  top: 8px;
  display: none;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  background: var(--lens-raised-surface);
  border: 1px solid var(--lens-hairline);
  border-radius: 10px;
  width: 240px;
  font-size: 11px;
  color: var(--lens-text-secondary);
  z-index: 20;
  pointer-events: none;
  box-shadow: var(--lens-shadow-blue);
}
.lens-queue-row:hover .lens-row-tooltip { display: flex; }
.lens-row-reason { color: var(--lens-text-muted); }

.lens-queue-empty {
  padding: 16px;
  text-align: center;
  color: var(--lens-text-muted);
  font-size: 12px;
  border: 1px dashed var(--lens-hairline);
  border-radius: 14px;
}
.lens-queue-expand {
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 999px;
  border: 1px solid var(--lens-hairline);
  background: rgba(90, 174, 255, 0.06);
  color: var(--lens-cyan);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-align: center;
}
.lens-queue-expand:hover { background: rgba(90, 174, 255, 0.12); }

/* =========================================================================
 * Center: Living Agent Lens
 * =========================================================================*/
.lens-center-column { display: flex; align-items: stretch; justify-content: center; min-height: 0; }
.lens-stage {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 540px;
  display: flex;
  align-items: center;
  justify-content: center;
  isolation: isolate;
}

/* Star field */
.lens-starfield { position: absolute; inset: 0; pointer-events: none; }
.lens-star {
  position: absolute;
  width: var(--lens-star-size, 1px);
  height: var(--lens-star-size, 1px);
  border-radius: 50%;
  background: rgba(180, 220, 255, 0.7);
  box-shadow: 0 0 4px rgba(180, 220, 255, 0.4);
  animation: lens-star-drift 90s linear infinite;
  animation-delay: var(--lens-star-delay, 0s);
}
@keyframes lens-star-drift {
  from { transform: translate3d(0, 0, 0); opacity: 0.4; }
  50%  { opacity: 0.9; }
  to   { transform: translate3d(20px, -14px, 0); opacity: 0.4; }
}

/* Lens circle stack */
.lens-circle {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: min(680px, 80%);
  aspect-ratio: 1 / 1;
  pointer-events: none;
}
.lens-aura {
  position: absolute; inset: -8%; border-radius: 50%;
  background:
    radial-gradient(circle at 50% 38%, rgba(90, 174, 255, 0.35), transparent 65%),
    radial-gradient(circle at 50% 62%, rgba(94, 203, 255, 0.18), transparent 70%);
  filter: blur(8px);
  animation: lens-breath 7s ease-in-out infinite;
}
@keyframes lens-breath {
  0%, 100% { opacity: 0.85; transform: scale(1); }
  50%      { opacity: 1.0; transform: scale(1.025); }
}
.lens-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid rgba(90, 174, 255, 0.5);
}
.lens-ring-outer {
  inset: 0;
  border-width: 1.5px;
  box-shadow: inset 0 0 80px rgba(90, 174, 255, 0.10), 0 0 60px rgba(90, 174, 255, 0.10);
  border-color: rgba(90, 174, 255, 0.75);
  animation: lens-outer-glow 8s ease-in-out infinite;
}
@keyframes lens-outer-glow {
  0%, 100% { box-shadow: inset 0 0 80px rgba(90, 174, 255, 0.10), 0 0 60px rgba(90, 174, 255, 0.10); }
  50%      { box-shadow: inset 0 0 100px rgba(90, 174, 255, 0.18), 0 0 90px rgba(90, 174, 255, 0.20); }
}
.lens-ring-dotted {
  inset: 7%;
  border-style: dashed;
  border-color: rgba(94, 203, 255, 0.35);
  animation: lens-spin 55s linear infinite;
}
@keyframes lens-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.lens-ring-inner {
  inset: 18%;
  border-color: rgba(180, 220, 255, 0.18);
  animation: lens-spin-reverse 80s linear infinite;
}
@keyframes lens-spin-reverse { from { transform: rotate(0deg); } to { transform: rotate(-360deg); } }

.lens-nucleus {
  position: absolute;
  top: 50%; left: 50%;
  width: 84px;
  height: 84px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  background:
    radial-gradient(circle at 50% 50%, rgba(180, 230, 255, 0.95), rgba(90, 174, 255, 0.0) 65%);
  box-shadow: 0 0 50px rgba(90, 174, 255, 0.6);
  animation: lens-shimmer 6s ease-in-out infinite;
}
@keyframes lens-shimmer {
  0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
  50%      { transform: translate(-50%, -50%) scale(1.06); opacity: 0.85; }
}

/* Lens ring tone overrides */
.lens-circle[data-tone="amber"] .lens-ring-outer,
.lens-circle[data-tone="amber"] .lens-ring-dotted { border-color: rgba(255, 195, 92, 0.65); }
.lens-circle[data-tone="amber"] .lens-aura { background: radial-gradient(circle at 50% 38%, rgba(255, 195, 92, 0.32), transparent 65%); }
.lens-circle[data-tone="red"] .lens-ring-outer { border-color: rgba(255, 111, 99, 0.7); }
.lens-circle[data-tone="red"] .lens-aura { background: radial-gradient(circle at 50% 50%, rgba(255, 111, 99, 0.30), transparent 70%); }
.lens-circle[data-tone="green"] .lens-ring-outer { border-color: rgba(116, 244, 141, 0.6); }
.lens-circle[data-tone="violet"] .lens-ring-outer { border-color: rgba(182, 155, 255, 0.6); }

/* Focus crown */
.lens-crown {
  position: absolute;
  top: 4%;
  left: 50%;
  transform: translateX(-50%);
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 14px 22px;
  background: rgba(7, 22, 32, 0.85);
  border: 1px solid rgba(90, 174, 255, 0.6);
  border-radius: 20px;
  box-shadow: 0 0 30px rgba(90, 174, 255, 0.18);
  min-width: 180px;
  text-align: center;
}
.lens-crown:hover { border-color: var(--lens-cyan); box-shadow: 0 0 40px rgba(94, 203, 255, 0.35); }
.lens-crown-id { font-size: 11px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: var(--lens-cyan); }
.lens-crown-title { font-size: 26px; font-weight: 850; line-height: 1.1; color: var(--lens-text); }
.lens-crown-run { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--lens-text-muted); letter-spacing: 0.04em; }
.lens-crown-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--lens-cyan); box-shadow: 0 0 10px rgba(94, 203, 255, 0.7); }
.lens-crown[data-has-focus="false"] .lens-crown-dot { background: var(--lens-text-disabled); box-shadow: none; }

/* Live refresh micro-indicator */
.lens-live-micro {
  position: absolute;
  top: 14%;
  left: 6%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  font-size: 10px;
  color: var(--lens-text-muted);
}
.lens-live-label { font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
.lens-oscillo { width: 80px; height: 24px; color: var(--lens-cyan); }
.lens-oscillo-line { stroke: currentColor; stroke-width: 1.4; fill: none; animation: lens-osc-pulse 1.6s ease-in-out infinite; }
@keyframes lens-osc-pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
.lens-live-value { font-size: 12px; font-weight: 800; color: var(--lens-text); font-variant-numeric: tabular-nums; }

/* Transcript confidence */
.lens-transcript-confidence {
  position: absolute;
  top: 14%;
  right: 6%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 14px;
  background: rgba(7, 22, 32, 0.7);
  border: 1px solid var(--lens-hairline);
  border-radius: 14px;
  text-align: right;
}
.lens-tc-label { font-size: 10px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: var(--lens-text-muted); }
.lens-tc-row { display: inline-flex; gap: 8px; align-items: baseline; }
.lens-tc-score { font-size: 18px; font-weight: 850; color: var(--lens-text); font-variant-numeric: tabular-nums; }
.lens-tc-qual { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: lowercase; color: var(--lens-text-muted); }
.lens-transcript-confidence[data-label="high"] .lens-tc-qual { color: var(--lens-green); }
.lens-transcript-confidence[data-label="medium"] .lens-tc-qual { color: var(--lens-amber); }
.lens-transcript-confidence[data-label="low"] .lens-tc-qual { color: var(--lens-orange); }
.lens-transcript-confidence[data-label="unavailable"] .lens-tc-qual { color: var(--lens-text-disabled); }

/* Current message card */
.lens-current-message {
  position: absolute;
  top: 36%;
  left: 4%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  width: 230px;
  background: rgba(8, 26, 38, 0.86);
  border: 1px solid rgba(94, 203, 255, 0.4);
  border-radius: 18px;
  text-align: left;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35), inset 0 0 30px rgba(90, 174, 255, 0.05);
}
.lens-msg-eyebrow { color: var(--lens-cyan); }
.lens-msg-role { font-size: 10px; font-weight: 700; letter-spacing: 0.05em; color: var(--lens-text-secondary); text-transform: lowercase; }
.lens-msg-excerpt { margin: 0; font-size: 12px; color: var(--lens-text); line-height: 1.4; max-height: 4.2em; overflow: hidden; }
.lens-msg-foot { display: flex; justify-content: space-between; align-items: center; }
.lens-msg-time { font-size: 10px; color: var(--lens-text-muted); font-variant-numeric: tabular-nums; }
.lens-msg-dots { display: inline-flex; gap: 4px; }
.lens-msg-dots span { width: 5px; height: 5px; border-radius: 50%; background: var(--lens-text-disabled); }
.lens-msg-dots span:first-child { background: var(--lens-cyan); }

/* Role stream */
.lens-role-stream {
  position: absolute;
  bottom: 26%;
  left: 5%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 220px;
}
.lens-role-eyebrow { color: var(--lens-text-muted); }
.lens-role-streams { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
.lens-role-segment {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 5px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--lens-hairline);
  font-size: 11px;
}
.lens-role-segment[data-tone="blue"] { border-color: rgba(90, 174, 255, 0.45); }
.lens-role-segment[data-tone="green"] { border-color: rgba(116, 244, 141, 0.4); }
.lens-role-segment[data-tone="amber"] { border-color: rgba(255, 195, 92, 0.45); }
.lens-role-segment[data-tone="violet"] { border-color: rgba(182, 155, 255, 0.4); }
.lens-role-name { color: var(--lens-text-secondary); text-transform: lowercase; }
.lens-role-count { font-weight: 800; color: var(--lens-text); font-variant-numeric: tabular-nums; }
.lens-role-empty { font-size: 11px; color: var(--lens-text-muted); grid-column: 1 / -1; }

/* Event orbit */
.lens-event-orbit {
  position: absolute;
  top: 50%;
  left: 50%;
  width: min(680px, 80%);
  aspect-ratio: 1 / 1;
  transform: translate(-50%, -50%);
  margin: 0;
  padding: 0;
  list-style: none;
  pointer-events: none;
  --lens-orbit-radius: 260px;
}
.lens-orbit-node {
  position: absolute;
  top: 50%;
  left: 50%;
  transform-origin: 0 0;
  /* Stable transform: orbit phase is driven via custom property + slot angle. */
  transform: rotate(calc(var(--lens-orbit-slot, 0deg) * 1deg + (var(--lens-orbit-phase, 0) * 360deg))) translate(var(--lens-orbit-radius, 260px)) rotate(calc(-1 * (var(--lens-orbit-slot, 0deg) * 1deg + (var(--lens-orbit-phase, 0) * 360deg))));
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(7, 22, 32, 0.85);
  border: 1px solid rgba(94, 203, 255, 0.5);
  border-radius: 999px;
  pointer-events: auto;
  cursor: pointer;
  font-size: 10px;
  color: var(--lens-text-secondary);
}
.lens-orbit-icon { color: var(--lens-cyan); }
.lens-orbit-text { display: inline-flex; align-items: baseline; gap: 6px; }
.lens-orbit-label { font-weight: 800; color: var(--lens-text); text-transform: lowercase; letter-spacing: 0.04em; }
.lens-orbit-time { font-variant-numeric: tabular-nums; color: var(--lens-text-muted); font-size: 9px; }
.lens-orbit-node[data-tone="amber"] { border-color: rgba(255, 195, 92, 0.65); }
.lens-orbit-node[data-tone="amber"] .lens-orbit-icon { color: var(--lens-amber); }
.lens-orbit-node[data-tone="red"] { border-color: rgba(255, 111, 99, 0.65); box-shadow: 0 0 14px rgba(255, 111, 99, 0.25); }
.lens-orbit-node[data-tone="red"] .lens-orbit-icon { color: var(--lens-red); }
.lens-orbit-node:hover { background: rgba(8, 30, 42, 0.95); transform: rotate(calc(var(--lens-orbit-slot, 0deg) * 1deg + (var(--lens-orbit-phase, 0) * 360deg))) translate(var(--lens-orbit-radius, 260px)) rotate(calc(-1 * (var(--lens-orbit-slot, 0deg) * 1deg + (var(--lens-orbit-phase, 0) * 360deg)))) scale(1.06); }
.lens-orbit-enter { animation: lens-orbit-enter-anim 420ms ease-out 1; }
@keyframes lens-orbit-enter-anim { from { opacity: 0; } to { opacity: 1; } }
.lens-orbit-leave { animation: lens-orbit-leave-anim 420ms ease-in 1 forwards; }
@keyframes lens-orbit-leave-anim { from { opacity: 1; } to { opacity: 0; } }

/* Hide orbit nodes that would collide with the message card on the left */
.lens-event-orbit { --lens-orbit-mask-start: 140; --lens-orbit-mask-end: 240; }

/* Bounded window */
.lens-context-window {
  position: absolute;
  bottom: 8%;
  left: 50%;
  transform: translateX(-50%);
  width: min(280px, 80%);
  padding: 10px 14px;
  background: rgba(7, 22, 32, 0.72);
  border: 1px solid var(--lens-hairline);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.lens-ctx-row { display: flex; justify-content: space-between; align-items: center; }
.lens-ctx-cap { font-size: 12px; font-weight: 700; color: var(--lens-text); }
.lens-ctx-lock { color: var(--lens-text-muted); }
.lens-ctx-bar {
  height: 5px;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(90, 174, 255, 0.18), rgba(90, 174, 255, 0.04));
  position: relative;
  overflow: hidden;
}
.lens-ctx-bar::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, var(--lens-cyan), var(--lens-blue));
  transform-origin: 0 50%;
  transform: scaleX(var(--lens-ctx-fill, 0));
  transition: transform 320ms ease;
}
.lens-ctx-detail { font-size: 10px; color: var(--lens-text-muted); }
.lens-context-window[data-scan-state="exhausted"] { border-color: rgba(255, 195, 92, 0.55); }
.lens-context-window[data-scan-state="unknown"] .lens-ctx-detail { color: var(--lens-amber); }

/* Anchors (invisible but positioned) */
.lens-intake-node, .lens-output-node, .lens-evidence-junction {
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: rgba(90, 174, 255, 0.25);
  border: 2px solid rgba(94, 203, 255, 0.7);
  pointer-events: none;
  z-index: 5;
}
.lens-intake-node { top: 50%; left: 12%; transform: translateY(-50%); }
.lens-output-node { top: 50%; right: 12%; transform: translateY(-50%); background: rgba(255, 195, 92, 0.25); border-color: rgba(255, 195, 92, 0.7); }
.lens-evidence-junction { bottom: 4%; left: 50%; transform: translateX(-50%); background: rgba(116, 244, 141, 0.25); border-color: rgba(116, 244, 141, 0.7); }

/* =========================================================================
 * Interlock Spine (right column)
 * =========================================================================*/
.lens-interlock-column { display: flex; flex-direction: column; min-height: 0; }
.lens-spine-shell { display: grid; grid-template-columns: 24px 1fr; gap: 14px; min-height: 0; }
.lens-spine-rail {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
}
.lens-spine-rail::before {
  content: '';
  position: absolute;
  top: 14px; bottom: 14px;
  width: 2px;
  background: linear-gradient(180deg, rgba(94, 203, 255, 0.5), rgba(94, 203, 255, 0.1));
  border-radius: 1px;
  animation: lens-spine-energy 4s ease-in-out infinite;
}
@keyframes lens-spine-energy {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
.lens-spine-node {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(7, 22, 32, 0.9);
  border: 2px solid rgba(94, 203, 255, 0.65);
  position: relative;
  z-index: 1;
}
.lens-spine-node[data-tone="green"] { border-color: var(--lens-green); box-shadow: 0 0 12px rgba(116, 244, 141, 0.55); }
.lens-spine-node[data-tone="amber"] { border-color: var(--lens-amber); box-shadow: 0 0 12px rgba(255, 195, 92, 0.55); }
.lens-spine-node[data-tone="red"] { border-color: var(--lens-red); box-shadow: 0 0 12px rgba(255, 111, 99, 0.55); }
.lens-spine-node[data-tone="blue"] { border-color: var(--lens-blue); box-shadow: 0 0 12px rgba(90, 174, 255, 0.55); }

.lens-spine-stack { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; scrollbar-width: thin; }
.lens-spine-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  background: var(--lens-deep-surface);
  border: 1px solid var(--lens-hairline);
  border-radius: 16px;
  transition: border-color 200ms ease, box-shadow 220ms ease;
}
.lens-spine-card[data-tone="green"] { border-color: rgba(116, 244, 141, 0.45); }
.lens-spine-card[data-tone="amber"] { border-color: rgba(255, 195, 92, 0.5); }
.lens-spine-card[data-tone="red"] { border-color: rgba(255, 111, 99, 0.55); }
.lens-spine-card-attention { box-shadow: 0 0 0 1px rgba(94, 203, 255, 0.65), 0 12px 40px rgba(90, 174, 255, 0.25); }

.lens-spine-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.lens-spine-title { margin: 0; font-size: 11px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--lens-text); }
.lens-spine-state { font-size: 10px; font-weight: 700; color: var(--lens-text-muted); }
.lens-spine-subtitle { margin: 0; font-size: 11px; color: var(--lens-text-secondary); }

.lens-spine-body { font-size: 11px; color: var(--lens-text-secondary); }

.lens-precond-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.lens-precond-item { display: grid; grid-template-columns: 12px 1fr; align-items: start; gap: 8px; }
.lens-precond-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; background: var(--lens-green); }
.lens-precond-item[data-ok="false"] .lens-precond-dot { background: var(--lens-amber); }
.lens-precond-text { display: flex; flex-direction: column; gap: 1px; }
.lens-precond-label { color: var(--lens-text); font-weight: 600; }
.lens-precond-detail { color: var(--lens-text-muted); font-size: 10px; }

.lens-intent { display: flex; flex-direction: column; gap: 4px; }
.lens-intent-capsule { display: inline-block; padding: 6px 10px; background: rgba(90, 174, 255, 0.10); border: 1px solid rgba(90, 174, 255, 0.35); border-radius: 999px; color: var(--lens-blue); font-weight: 700; font-size: 11px; width: max-content; }
.lens-intent-reason { font-size: 10px; color: var(--lens-amber); }

.lens-preview { display: flex; flex-direction: column; gap: 4px; }
.lens-preview-endpoint { font-family: "SF Mono", "Menlo", monospace; font-size: 10px; color: var(--lens-text-muted); }
.lens-preview-code { margin: 0; padding: 8px 10px; border-radius: 8px; background: rgba(0, 0, 0, 0.35); font-family: "SF Mono", "Menlo", monospace; font-size: 10px; color: var(--lens-text); white-space: pre-wrap; max-height: 96px; overflow: auto; }

.lens-receipt { display: flex; flex-direction: column; gap: 3px; }
.lens-receipt-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.lens-receipt-id { font-family: "SF Mono", "Menlo", monospace; font-size: 11px; color: var(--lens-text); }
.lens-receipt-lifecycle { font-size: 10px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--lens-text-muted); }
.lens-receipt-result { font-size: 10px; color: var(--lens-text-secondary); }

/* =========================================================================
 * Evidence Path + Dock
 * =========================================================================*/
.lens-lower { display: flex; flex-direction: column; gap: 12px; }
.lens-evidence {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
  background: linear-gradient(90deg, rgba(8, 30, 22, 0.5), rgba(8, 30, 22, 0.0));
  border: 1px solid rgba(116, 244, 141, 0.25);
  border-radius: 16px;
}
.lens-evidence-rail { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.lens-evidence-pill {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 14px;
  border: 1px solid var(--lens-hairline);
  background: rgba(7, 22, 32, 0.65);
  text-align: left;
  min-width: 0;
}
.lens-evidence-pill[data-tone="green"] { border-color: rgba(116, 244, 141, 0.55); }
.lens-evidence-pill[data-tone="amber"] { border-color: rgba(255, 195, 92, 0.55); }
.lens-evidence-pill[data-tone="red"] { border-color: rgba(255, 111, 99, 0.55); }
.lens-evidence-pill[data-tone="gray"] { border-color: var(--lens-hairline); opacity: 0.7; }

.lens-evidence-label { font-size: 9px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: var(--lens-text-muted); }
.lens-evidence-value { font-family: "SF Mono", "Menlo", monospace; font-size: 11px; color: var(--lens-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lens-evidence-detail { font-size: 10px; color: var(--lens-amber); }
.lens-evidence-copy { padding: 2px 8px; border-radius: 6px; border: 1px solid var(--lens-hairline); color: var(--lens-text-muted); font-size: 10px; font-weight: 600; }
.lens-evidence-copy:hover { color: var(--lens-cyan); border-color: rgba(94, 203, 255, 0.5); }

.lens-evidence-lower { display: flex; align-items: center; gap: 10px; }
.lens-evidence-path-capsule { padding: 6px 12px; border-radius: 999px; background: rgba(116, 244, 141, 0.08); border: 1px solid rgba(116, 244, 141, 0.3); color: var(--lens-text-secondary); font-family: "SF Mono", "Menlo", monospace; font-size: 10px; }
.lens-evidence-view { padding: 6px 14px; border-radius: 8px; border: 1px solid rgba(116, 244, 141, 0.5); color: var(--lens-green); font-weight: 700; font-size: 11px; }
.lens-evidence-view:hover { background: rgba(116, 244, 141, 0.08); }
.lens-evidence-snapshot { padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(116, 244, 141, 0.3); color: var(--lens-text-secondary); font-size: 10px; }
.lens-evidence-snapshot[data-tone="amber"] { border-color: rgba(255, 195, 92, 0.5); color: var(--lens-amber); }
.lens-evidence-snapshot[data-tone="red"] { border-color: rgba(255, 111, 99, 0.5); color: var(--lens-red); }

/* Action dock */
.lens-dock {
  display: flex;
  flex-direction: column;
  padding: 0;
}
.lens-dock-row { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; padding: 4px 0; }
.lens-dock-button {
  display: grid;
  grid-template-columns: 28px 1fr;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  min-height: 64px;
  background: var(--lens-deep-surface);
  border: 1px solid var(--lens-hairline);
  border-radius: 18px;
  text-align: left;
  position: relative;
  transition: transform 160ms ease, border-color 200ms ease, box-shadow 220ms ease;
}
.lens-dock-button:hover { transform: translateY(-2px); border-color: rgba(94, 203, 255, 0.5); box-shadow: 0 8px 24px rgba(90, 174, 255, 0.15); }
.lens-dock-button[data-tone="blue"] { border-color: rgba(90, 174, 255, 0.55); }
.lens-dock-button[data-tone="green"] { border-color: rgba(116, 244, 141, 0.5); }
.lens-dock-button[data-tone="amber"] { border-color: rgba(255, 195, 92, 0.55); }
.lens-dock-button[data-tone="violet"] { border-color: rgba(182, 155, 255, 0.55); }
.lens-dock-button[data-tone="red"] { border-color: rgba(255, 111, 99, 0.55); }
.lens-dock-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 8px; color: var(--lens-cyan); background: rgba(94, 203, 255, 0.08); }
.lens-dock-button[data-tone="green"] .lens-dock-icon { color: var(--lens-green); background: rgba(116, 244, 141, 0.08); }
.lens-dock-button[data-tone="amber"] .lens-dock-icon { color: var(--lens-amber); background: rgba(255, 195, 92, 0.08); }
.lens-dock-button[data-tone="violet"] .lens-dock-icon { color: var(--lens-violet); background: rgba(182, 155, 255, 0.08); }
.lens-dock-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.lens-dock-label { font-size: 14px; font-weight: 800; color: var(--lens-text); }
.lens-dock-intent { font-size: 11px; color: var(--lens-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.lens-dock-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  width: 220px;
  display: flex;
  flex-direction: column;
  padding: 6px;
  background: var(--lens-raised-surface);
  border: 1px solid var(--lens-hairline);
  border-radius: 12px;
  box-shadow: var(--lens-shadow-blue);
  z-index: 40;
}
.lens-dock-menu-item {
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--lens-text);
  text-align: left;
}
.lens-dock-menu-item:hover { background: rgba(94, 203, 255, 0.08); }

/* =========================================================================
 * Footer
 * =========================================================================*/
.lens-footer {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 14px;
  padding: 10px 16px;
  border-top: 1px solid var(--lens-hairline);
  background: rgba(2, 7, 11, 0.6);
  border-radius: 14px;
  align-items: center;
}
.lens-footer-cell { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px; }
.lens-footer-cell-button { border-radius: 8px; border: 1px solid transparent; }
.lens-footer-cell-button:hover { border-color: var(--lens-hairline); background: rgba(255, 255, 255, 0.03); }
.lens-footer-label { font-size: 10px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--lens-text-muted); }
.lens-footer-value { font-size: 12px; font-weight: 700; color: var(--lens-text); font-variant-numeric: tabular-nums; }
.lens-footer-text { display: flex; flex-direction: column; line-height: 1.2; }
.lens-footer-icon { color: var(--lens-text-muted); }
.lens-footer-cell[data-tone="green"] .lens-footer-icon { color: var(--lens-green); }
.lens-footer-cell[data-tone="amber"] .lens-footer-icon { color: var(--lens-amber); }
.lens-footer-cell[data-tone="red"] .lens-footer-icon { color: var(--lens-red); }

/* =========================================================================
 * Connectors (SVG layer)
 * =========================================================================*/
.lens-connectors-host {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}
.lens-connectors { position: absolute; inset: 0; width: 100%; height: 100%; }
.lens-conn-path {
  fill: none;
  stroke: rgba(90, 174, 255, 0.7);
  stroke-width: 1.6;
  transition: stroke 240ms ease, stroke-width 240ms ease, opacity 240ms ease;
  opacity: 0.9;
  filter: drop-shadow(0 0 4px rgba(90, 174, 255, 0.35));
}
.lens-conn-path[data-tone="amber"] { stroke: rgba(255, 195, 92, 0.85); filter: drop-shadow(0 0 4px rgba(255, 195, 92, 0.35)); }
.lens-conn-path[data-tone="red"] { stroke: rgba(255, 111, 99, 0.9); filter: drop-shadow(0 0 4px rgba(255, 111, 99, 0.4)); }
.lens-conn-path[data-tone="green"] { stroke: rgba(116, 244, 141, 0.85); filter: drop-shadow(0 0 4px rgba(116, 244, 141, 0.35)); }
.lens-conn-path[data-tone="neutral"] { stroke: rgba(135, 165, 195, 0.5); }
.lens-conn-path[data-focus="true"] { stroke: var(--lens-cyan); stroke-width: 2.2; opacity: 1; filter: drop-shadow(0 0 8px rgba(94, 203, 255, 0.7)); }
.lens-conn-path[data-hover="true"] { stroke: var(--lens-cyan); stroke-width: 2.4; opacity: 1; filter: drop-shadow(0 0 10px rgba(94, 203, 255, 0.85)); }

/* =========================================================================
 * Reduced-motion variant
 * =========================================================================*/
@media (prefers-reduced-motion: reduce) {
  .lens-star,
  .lens-aura,
  .lens-ring-outer,
  .lens-ring-dotted,
  .lens-ring-inner,
  .lens-nucleus,
  .lens-oscillo-line,
  .lens-spine-rail::before,
  .lens-cell[data-cell="audit"] .lens-cell-icon,
  .lens-orbit-enter,
  .lens-orbit-leave { animation: none !important; }
  .lens-orbit-node { transform: rotate(calc(var(--lens-orbit-slot, 0deg) * 1deg)) translate(170px) rotate(calc(-1 * var(--lens-orbit-slot, 0deg) * 1deg)); }
}
.lens-app[data-reduced-motion="true"] .lens-orbit-node {
  transform: rotate(calc(var(--lens-orbit-slot, 0deg) * 1deg)) translate(170px) rotate(calc(-1 * var(--lens-orbit-slot, 0deg) * 1deg));
}

/* =========================================================================
 * Responsive breakpoints
 * =========================================================================*/
@media (max-width: 1279px) {
  .lens-stage-grid { grid-template-columns: 248px 1fr 282px; gap: 14px; }
  .lens-dock-button { padding: 12px 14px; min-height: 58px; }
  .lens-dock-label { font-size: 13px; }
  .lens-current-message { width: 200px; }
  .lens-role-stream { width: 200px; }
  .lens-event-orbit { width: min(560px, 80%); }
  .lens-orbit-node { transform: rotate(calc(var(--lens-orbit-slot, 0deg) * 1deg + (var(--lens-orbit-phase, 0) * 360deg))) translate(150px) rotate(calc(-1 * (var(--lens-orbit-slot, 0deg) * 1deg + (var(--lens-orbit-phase, 0) * 360deg)))); }
}

@media (max-width: 1023px) {
  .lens-app { height: auto; min-height: 100vh; overflow: auto; }
  .lens-stage-grid { grid-template-columns: 1fr; }
  .lens-stage { min-height: 480px; }
  .lens-ribbon { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .lens-evidence-rail { grid-template-columns: 1fr 1fr; }
  .lens-dock-row { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .lens-footer { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .lens-conn-queue, .lens-conn-interlock, .lens-conn-evidence { display: none; }
}

@media (max-width: 699px) {
  .lens-app { padding: 12px 12px 12px; }
  .lens-ribbon { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lens-evidence-rail { grid-template-columns: 1fr; }
  .lens-dock-row { grid-template-columns: 1fr; }
  .lens-footer { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lens-stage { min-height: 360px; }
  .lens-circle { width: min(420px, 90%); }
  .lens-current-message, .lens-role-stream { display: none; }
}
`;
