import { renderAppleConstellationStyles } from './apple-constellation-styles';

export function renderDashboardStylesCss(): string {
  return `:root {
  --bg: #02070b;
  --panel: #07131d;
  --line: rgba(122, 177, 219, 0.22);
  --ink: #eaf6ff;
  --muted: #8aa0b2;
  --accent: #5aaeff;
  --accent-soft: rgba(90, 174, 255, 0.16);
  --pink: #b69bff;
  --pink-soft: rgba(182, 155, 255, 0.16);
  --warn: #ffc35c;
  --warn-soft: rgba(255, 195, 92, 0.14);
  --danger: #ff6f63;
  --danger-soft: rgba(255, 111, 99, 0.14);
  --glow: rgba(90, 174, 255, 0.16);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  color: var(--ink);
  font-family: "Avenir Next", "IBM Plex Sans", "Segoe UI", sans-serif;
  background: #02070b;
  position: relative;
  overflow-x: hidden;
}

.backdrop {
  position: fixed;
  inset: 0;
  background:
    radial-gradient(circle at 50% -8%, rgba(56, 151, 255, 0.22), transparent 0 28%, transparent 48%),
    linear-gradient(180deg, rgba(9, 22, 32, 0.96), rgba(2, 7, 11, 0.98));
  pointer-events: none;
}

.hero {
  position: relative;
  top: 0;
  z-index: 5;
  min-height: 92px;
  display: grid;
  grid-template-columns: 86px minmax(250px, 350px) minmax(0, 1fr);
  gap: 16px;
  align-items: center;
  padding: 10px 28px;
  border: 1px solid rgba(122, 177, 219, 0.18);
  border-top: 0;
  border-radius: 0 0 30px 30px;
  background:
    linear-gradient(180deg, rgba(8, 20, 30, 0.96), rgba(5, 15, 23, 0.9)),
    rgba(3, 9, 14, 0.96);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 18px 48px rgba(0, 0, 0, 0.34);
  backdrop-filter: blur(18px);
}

.window-controls {
  display: flex;
  gap: 8px;
  align-self: start;
  padding-top: 6px;
}

.window-controls span {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #ff675d;
  box-shadow: 0 0 12px rgba(255, 103, 93, 0.42);
}

.window-controls span:nth-child(2) {
  background: #ffc15f;
  box-shadow: 0 0 12px rgba(255, 193, 95, 0.36);
}

.window-controls span:nth-child(3) {
  background: #68db75;
  box-shadow: 0 0 12px rgba(104, 219, 117, 0.36);
}

.hero-title {
  min-width: 0;
}

.eyebrow {
  margin: 0 0 2px;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 10px;
  font-weight: 750;
  color: #86a2b8;
}

h1 {
  margin: 0;
  color: #f1f8ff;
  font-family: "Avenir Next", "IBM Plex Sans", "Segoe UI", sans-serif;
  font-size: 19px;
  line-height: 1.12;
  letter-spacing: 0;
}

.hero-subtitle {
  margin: 2px 0 0;
  color: #a7bacb;
  font-size: 13px;
}

.hero-status-card {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(112px, 1.05fr) minmax(106px, 0.86fr) minmax(118px, 0.92fr) minmax(96px, 0.76fr) minmax(122px, 1fr) auto;
  align-items: center;
  gap: 0;
  border: 1px solid rgba(122, 177, 219, 0.16);
  border-radius: 999px;
  background: rgba(4, 14, 22, 0.72);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07);
  overflow: clip;
}

.chrome-token {
  min-height: 56px;
  min-width: 0;
  display: grid;
  align-content: center;
  gap: 2px;
  padding: 8px 18px;
  border-right: 1px solid rgba(122, 177, 219, 0.16);
}

.status-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.status-kicker {
  color: #839bad;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.chrome-token strong {
  min-width: 0;
  overflow: hidden;
  color: #e7f5ff;
  font-size: 13px;
  font-weight: 650;
  line-height: 1.22;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chrome-token-wide strong::after,
.chrome-token-audit strong::before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  margin: 0 7px;
  border-radius: 50%;
  background: #70f08a;
  box-shadow: 0 0 12px rgba(112, 240, 138, 0.8);
}

.chrome-token-audit strong::before {
  background: #ff6f63;
  box-shadow: 0 0 12px rgba(255, 111, 99, 0.8);
}

.badge {
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.badge-live {
  background: rgba(112, 240, 138, 0.16);
  color: #80f296;
}

.badge-polling {
  background: rgba(90, 174, 255, 0.16);
  color: #79bdff;
}

.badge-connecting {
  background: rgba(255, 195, 92, 0.16);
  color: #ffd07a;
}

.badge-offline {
  background: rgba(255, 111, 99, 0.18);
  color: #ff8f87;
}

.hero-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  min-width: 132px;
}

.action-required-banner {
  margin: 10px 24px 0;
  border: 1px solid #d58a44;
  background: #fff5e8;
  color: #8a4b12;
  border-radius: 12px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.api-degraded-banner {
  margin: 10px 24px 0;
  border: 1px solid var(--danger);
  background: var(--danger-soft);
  color: var(--danger);
  border-radius: 12px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.runtime-stale-banner {
  margin: 10px 24px 0;
  border: 1px solid var(--danger);
  background: var(--danger-soft);
  color: var(--danger);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.runtime-update-banner {
  margin: 10px 24px 0;
  border: 1px solid #2563eb;
  background: #eef4ff;
  color: #1f4fa3;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.runtime-update-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.reason-chip {
  font-size: 11px;
  padding: 4px 8px;
  color: #8a4b12;
  border-color: #e9c9a4;
}

button,
select,
input {
  font: inherit;
}

button {
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: white;
  padding: 9px 14px;
  cursor: pointer;
  font-weight: 600;
}

button:hover {
  filter: brightness(1.06);
}

.refresh-now-button {
  border: 1px solid rgba(122, 177, 219, 0.28);
  border-radius: 999px;
  background: rgba(5, 17, 26, 0.82);
  color: #d9edf9;
  font-size: 12px;
  padding: 8px 13px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.refresh-now-button:hover {
  background: rgba(15, 39, 58, 0.92);
  filter: none;
}

.refresh-now-button:focus-visible {
  outline: 2px solid rgba(90, 174, 255, 0.76);
  outline-offset: 2px;
}

.ghost-button {
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 8px;
  font-size: 12px;
}

.compact-toolbar {
  align-items: center;
}

input,
select {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: white;
  padding: 8px 10px;
}

.layout {
  padding: 18px 24px 28px;
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(12, minmax(0, 1fr));
}

.panel {
  grid-column: span 6;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 12px 26px rgba(19, 32, 21, 0.06);
  padding: 14px;
}

.panel-wide {
  grid-column: span 12;
}

.snapshot-error {
  border-color: var(--danger);
  background: #fff7f5;
}

.hidden {
  display: none;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

h2 {
  margin: 0;
  font-family: "Iowan Old Style", "IBM Plex Serif", serif;
  font-size: 20px;
}

h3 {
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 12px;
  color: var(--muted);
}

.kpi-grid {
  margin-top: 10px;
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
}

.kpi-card {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #f8fcf7;
  padding: 10px;
}

.kpi-card p {
  margin: 6px 0 0;
  font-size: 22px;
  font-family: "Iowan Old Style", "IBM Plex Serif", serif;
}

.retry-status-summary {
  margin-top: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fffaf2;
  padding: 10px;
}

.retry-status-header {
  font-weight: 700;
  color: #8a4b12;
  margin-bottom: 8px;
}

.retry-status-list {
  display: grid;
  gap: 8px;
}

.retry-status-item {
  border-left: 3px solid var(--warn);
  padding-left: 9px;
}

.retry-status-item.overdue {
  border-left-color: var(--danger);
}

.rate-limit-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.rate-limit-card {
  flex: 1 1 300px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #f8fcf7;
  padding: 12px;
  display: grid;
  gap: 10px;
}

.rate-limit-card-warning {
  border-color: #d58a44;
  background: #fff8ef;
}

.rate-limit-card-critical {
  border-color: var(--danger);
  background: #fff7f5;
}

.rate-limit-empty {
  border-style: dashed;
  color: var(--muted);
}

.rate-limit-title {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
}

.rate-limit-name {
  font-weight: 800;
}

.rate-limit-status {
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
  background: var(--accent-soft);
  color: var(--accent);
}

.rate-limit-card-warning .rate-limit-status {
  background: var(--warn-soft);
  color: var(--warn);
}

.rate-limit-card-critical .rate-limit-status {
  background: var(--danger-soft);
  color: var(--danger);
}

.rate-limit-meter {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: #e5eee2;
  position: relative;
}

.rate-limit-meter-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), var(--pink));
}

.rate-limit-time-marker {
  position: absolute;
  top: -4px;
  bottom: -4px;
  width: 2px;
  border-radius: 999px;
  background: #1b2d21;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.82), 0 0 0 4px rgba(20, 95, 75, 0.28);
  transform: translateX(-1px);
}

.rate-limit-meter-legend {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
}

.rate-limit-metrics {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.rate-limit-metric {
  min-width: 0;
}

.rate-limit-metric span {
  display: block;
  color: var(--muted);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.rate-limit-metric strong {
  display: block;
  margin-top: 2px;
  font-size: 18px;
  line-height: 1.1;
  overflow-wrap: anywhere;
}

.rate-limit-detail-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.rate-limit-chip {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.68);
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.rate-limit-forecast {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(3, minmax(86px, 1fr));
}

.rate-limit-marker {
  border: 1px solid rgba(95, 114, 101, 0.2);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.72);
  padding: 8px;
  min-width: 0;
}

.rate-limit-marker-positive {
  border-color: rgba(20, 95, 75, 0.22);
  background: rgba(216, 237, 229, 0.58);
}

.rate-limit-marker-deficit {
  border-color: rgba(170, 55, 40, 0.25);
  background: rgba(253, 234, 230, 0.7);
}

.rate-limit-marker span {
  display: block;
  color: var(--muted);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.rate-limit-marker strong {
  display: block;
  margin-top: 3px;
  font-size: 13px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.rate-limit-caption {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.35;
}

.rate-limit-summary {
  flex: 1 0 100%;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
  border: 1px solid rgba(20, 95, 75, 0.14);
  border-radius: 8px;
  background: rgba(216, 237, 229, 0.38);
  padding: 8px 10px;
  color: var(--muted);
  font-size: 12px;
}

.rate-limit-summary span {
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.rate-limit-summary strong {
  color: var(--ink);
  text-align: right;
}

.drain-mode-panel {
  border-color: #b6c9b8;
}

.drain-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.drain-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.52;
  filter: none;
}

.runtime-update-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.52;
  filter: none;
}

.drain-mode-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.9fr) minmax(320px, 1.1fr);
  gap: 14px;
  align-items: start;
}

.runtime-update-panel {
  border-color: #b8c7e6;
}

.runtime-update-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.75fr) minmax(340px, 1.25fr);
  gap: 14px;
  align-items: start;
}

.runtime-update-guidance {
  line-height: 1.45;
}

.runtime-update-details {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 8px;
}

.runtime-update-fact {
  min-width: 0;
  border: 1px solid #d7e0f2;
  border-radius: 8px;
  background: #f8fbff;
  padding: 9px;
}

.runtime-update-fact strong,
.runtime-update-fact span {
  display: block;
}

.runtime-update-fact strong {
  color: #244f95;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.runtime-update-fact span {
  margin-top: 4px;
  overflow-wrap: anywhere;
}

.drain-boundary {
  margin: 8px 0;
  border-radius: 8px;
  padding: 9px 10px;
  font-weight: 700;
}

.drain-boundary-safe {
  color: var(--accent);
  background: var(--accent-soft);
}

.drain-boundary-blocked {
  color: var(--danger);
  background: var(--danger-soft);
}

.drain-blockers-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 8px;
}

.drain-blocker-item {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px;
  background: #fbfdf9;
}

.drain-blocker-item strong,
.drain-blocker-item span {
  display: block;
}

.drain-blocker-item span {
  margin-top: 4px;
  color: var(--muted);
  overflow-wrap: anywhere;
}

.drain-blocker-active {
  border-color: #d58a44;
  background: #fff8ef;
}

.retry-status-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.retry-status-reason {
  margin-top: 4px;
  font-weight: 600;
}

.health {
  margin: 0;
  border-radius: 10px;
  padding: 8px 10px;
  font-weight: 600;
}

.health-ok {
  color: var(--accent);
  background: var(--accent-soft);
}

.health-failed {
  color: var(--danger);
  background: var(--danger-soft);
}

.muted {
  color: var(--muted);
}

.status-ok {
  color: var(--accent);
}

.status-error {
  color: var(--danger);
}

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
}

.table-wrap {
  overflow: auto;
}

.recovery-list {
  display: grid;
  gap: 10px;
}

.recovery-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  background: #fbfdf9;
}

.recovery-card-warning {
  border-color: #d58a44;
  background: #fff7f5;
}

.recovery-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.recovery-card h3 {
  margin: 0;
  font-size: 15px;
}

.recovery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
  margin: 0 0 10px;
}

.recovery-grid div {
  min-width: 0;
}

.recovery-grid dt {
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.recovery-grid dd {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
}

.recovery-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.capability-warning-text {
  color: var(--danger);
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
  vertical-align: top;
}

.selected-row {
  background: #e8f4ee;
}

.state-badge {
  display: inline-flex;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 700;
}

.state-active {
  background: var(--accent-soft);
  color: var(--accent);
}

.state-idle {
  background: #eef0f2;
  color: #425264;
}

.state-terminal {
  background: #efefef;
  color: #595959;
}

.state-neutral {
  background: #f2efe6;
  color: #6c5c2e;
}

.inline-badges {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mini-badge {
  display: inline-flex;
  border-radius: 999px;
  padding: 2px 7px;
  font-size: 10px;
  font-weight: 700;
}

.mini-badge-good {
  background: #e3f4ea;
  color: #1a6e3e;
}

.mini-badge-warning {
  background: #fff1df;
  color: #8a4b12;
}

.mini-badge-missing {
  background: #eef0f2;
  color: #425264;
}

.mini-badge-bad {
  background: #f8e8e8;
  color: #8a2f2f;
}

.project-history-table td {
  min-width: 120px;
}

.project-history-facts-cell {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 220px;
}

.project-history-detail {
  margin-top: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fbfdf9;
  padding: 12px;
}

.project-history-detail-grid {
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
}

.project-history-timeline-list {
  margin: 8px 0 0;
  padding-left: 18px;
}

.project-history-timeline-list li {
  margin: 5px 0;
  overflow-wrap: anywhere;
}

.root-cause-block {
  border-left: 3px solid var(--danger);
  margin-bottom: 8px;
  padding-left: 8px;
}

.root-cause-label {
  color: var(--danger);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.root-cause-summary {
  font-weight: 700;
}

.status-pill {
  display: inline-flex;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
}

.status-pill.pending {
  background: #fff1df;
  color: #8a4b12;
}

.status-pill.failed {
  background: var(--danger-soft);
  color: var(--danger);
}

.status-pill.actionability-none,
.operator-hint.actionability-none {
  background: #eef0f2;
  color: #425264;
}

.status-pill.actionability-recommended,
.operator-hint.actionability-recommended {
  background: #e8f1ff;
  color: #1f4f99;
}

.status-pill.actionability-required,
.operator-hint.actionability-required {
  background: var(--danger-soft);
  color: var(--danger);
}

.operator-hint {
  display: inline-flex;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 700;
}

.operator-explainer {
  margin-top: 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px;
  background: #f8fcf7;
}

.operator-explainer.actionability-required {
  border-color: #efaaa1;
  background: #fff7f5;
}

.operator-explainer.actionability-recommended {
  border-color: #a8c4ee;
  background: #f4f8ff;
}

.operator-explainer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.operator-explainer-grid {
  margin: 10px 0 0;
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.operator-explainer-grid div {
  min-width: 0;
}

.operator-explainer-grid dt {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.operator-explainer-grid dd {
  margin: 3px 0 0;
  overflow-wrap: anywhere;
}

.conversation-panel {
  margin-top: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f7fbff;
  padding: 10px;
}

.conversation-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}

.conversation-panel h3 {
  margin: 0 0 4px;
  font-size: 16px;
}

.conversation-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: grid;
  gap: 8px;
  max-height: 360px;
  overflow: auto;
}

.conversation-item {
  border-left: 4px solid #6f8496;
  border-radius: 6px;
  background: #ffffff;
  padding: 8px 10px;
  overflow-wrap: anywhere;
}

.conversation-density-compact .conversation-item {
  padding: 5px 8px;
}

.conversation-density-compact .conversation-item p {
  margin-top: 3px;
}

.conversation-role-system {
  border-left-color: #455a64;
}

.conversation-role-user {
  border-left-color: #1f7a5d;
}

.conversation-role-assistant {
  border-left-color: #2563eb;
}

.conversation-role-tool {
  border-left-color: #9a4f17;
}

.conversation-role-runtime {
  border-left-color: #7c4d93;
}

.conversation-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  color: var(--muted);
  font-size: 12px;
}

.conversation-role {
  color: var(--ink);
  font-weight: 800;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.08em;
}

.conversation-item p {
  margin: 5px 0 0;
  line-height: 1.4;
}

.thread-detail {
  margin-top: 12px;
}

.thread-detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(260px, 0.8fr);
  gap: 12px;
}

.thread-detail-section {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fbfdf9;
  padding: 10px;
}

.timeline-lanes {
  display: grid;
  gap: 8px;
}

.timeline-lane {
  border-left: 4px solid #7aa182;
  padding-left: 8px;
}

.timeline-lane-tool {
  border-left-color: #416b9b;
}

.timeline-lane-wait {
  border-left-color: #b35f4b;
}

.timeline-lane h4 {
  margin: 0 0 4px;
  font-size: 13px;
}

.timeline-lane ul {
  margin: 0;
  padding-left: 18px;
}

.timeline-lane li {
  margin: 4px 0;
  overflow-wrap: anywhere;
}

.blocker-card {
  margin: 0;
  display: grid;
  gap: 8px;
}

.blocker-card div {
  min-width: 0;
}

.blocker-card dt {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.blocker-card dd {
  margin: 3px 0 0;
  overflow-wrap: anywhere;
}

.raw-event-stream {
  max-height: 220px;
}

.action-cell {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

details summary {
  cursor: pointer;
  font-family: "Iowan Old Style", "IBM Plex Serif", serif;
  font-size: 20px;
}

.issue-detail {
  margin-top: 10px;
}

.inline-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.code-block {
  margin: 10px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  background: #f6faf5;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px;
  max-height: 320px;
  overflow: auto;
}

.list {
  margin: 8px 0 0;
  padding-left: 16px;
  display: grid;
  gap: 8px;
}

@media (max-width: 1080px) {
  .hero {
    position: static;
    grid-template-columns: 1fr;
    border-radius: 0;
  }

  .hero-status-card {
    width: 100%;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    border-radius: 18px;
  }

  .window-controls {
    display: none;
  }

  .panel {
    grid-column: span 12;
  }

  .thread-detail-grid {
    grid-template-columns: 1fr;
  }

  .drain-mode-grid {
    grid-template-columns: 1fr;
  }

  .runtime-update-grid {
    grid-template-columns: 1fr;
  }

  .panel-head {
    flex-direction: column;
    align-items: flex-start;
  }

  .toolbar {
    width: 100%;
    flex-direction: column;
    align-items: stretch;
  }
}

${renderAppleConstellationStyles()}
`;
}
