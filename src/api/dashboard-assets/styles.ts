export function renderDashboardStylesCss(): string {
  return `:root {
  --bg: #eef3ea;
  --panel: #ffffff;
  --line: #d6dfd1;
  --ink: #1b2d21;
  --muted: #5f7265;
  --accent: #145f4b;
  --accent-soft: #d8ede5;
  --warn: #a04f1e;
  --warn-soft: #feeede;
  --danger: #aa3728;
  --danger-soft: #fdeae6;
  --glow: rgba(20, 95, 75, 0.1);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  color: var(--ink);
  font-family: "Avenir Next", "IBM Plex Sans", "Segoe UI", sans-serif;
  background: radial-gradient(circle at 15% 0%, #f4faf3 0%, var(--bg) 45%, #e8efe4 100%);
  position: relative;
}

.backdrop {
  position: fixed;
  inset: 0;
  background: linear-gradient(120deg, rgba(102, 159, 132, 0.16), rgba(81, 130, 175, 0.1));
  pointer-events: none;
}

.hero {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: flex-start;
  padding: 20px 24px;
  border-bottom: 1px solid var(--line);
  background: rgba(249, 252, 248, 0.9);
  backdrop-filter: blur(10px);
}

.eyebrow {
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 11px;
  color: var(--muted);
}

h1 {
  margin: 4px 0 6px;
  font-family: "Iowan Old Style", "IBM Plex Serif", serif;
  font-size: 30px;
}

.hero-subtitle {
  margin: 0;
  color: var(--muted);
  max-width: 620px;
}

.hero-status-card {
  min-width: 310px;
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 12px;
  background: var(--panel);
  box-shadow: 0 12px 28px var(--glow);
}

.status-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.badge {
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.badge-live {
  background: var(--accent-soft);
  color: var(--accent);
}

.badge-polling {
  background: #eef4ff;
  color: #1f5fbf;
}

.badge-connecting {
  background: var(--warn-soft);
  color: var(--warn);
}

.badge-offline {
  background: #fee2e2;
  color: #b91c1c;
}

.hero-actions {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
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
  background: #2563eb;
  color: #ffffff;
}

.refresh-now-button:hover {
  background: #1d4ed8;
  filter: none;
}

.refresh-now-button:focus-visible {
  outline: 2px solid #93c5fd;
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

.drain-mode-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.9fr) minmax(320px, 1.1fr);
  gap: 14px;
  align-items: start;
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
    flex-direction: column;
  }

  .hero-status-card {
    width: 100%;
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
`;
}
