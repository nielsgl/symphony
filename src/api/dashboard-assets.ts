export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Symphony Local Control</title>
  <link rel="stylesheet" href="/dashboard/styles.css" />
  <script src="/dashboard/client.js" defer></script>
</head>
<body>
  <div class="bg-shape bg-shape-a"></div>
  <div class="bg-shape bg-shape-b"></div>
  <header class="topbar">
    <div>
      <p class="eyebrow">Symphony</p>
      <h1>Operator Control Surface</h1>
    </div>
    <div class="topbar-actions">
      <button id="refresh-button" type="button">Refresh now</button>
      <span id="refresh-status" aria-live="polite"></span>
    </div>
  </header>

  <main class="layout">
    <section class="panel panel-wide">
      <h2>System health</h2>
      <p id="health" class="health-ok">Dispatch validation: ok</p>
      <p id="last-error" class="muted"></p>
      <div class="metric-grid" id="overview-metrics"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Running queue</h2>
        <input id="running-filter" type="search" placeholder="Filter issues (/)" aria-label="Filter running issues" />
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Session</th>
              <th>State</th>
              <th>Turns</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody id="running-rows">
            <tr><td colspan="5" class="muted">No running issues.</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h2>Retry queue</h2>
      <ul id="retry-list" class="list"></ul>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Issue detail</h2>
        <div class="inline-form">
          <input id="issue-input" type="text" placeholder="ABC-123" aria-label="Issue identifier" />
          <button id="issue-button" type="button">Load</button>
        </div>
      </div>
      <pre id="issue-output" class="code">Select a running issue or type an issue identifier.</pre>
    </section>
  </main>
</body>
</html>`;
}

export function renderDashboardClientJs(): string {
  return `(() => {
  const state = {
    filter: '',
    selectedIssue: '',
    pollDelayMs: 5000,
    pollTimer: null,
    lastPayload: null
  };

  const elements = {
    refreshButton: document.getElementById('refresh-button'),
    refreshStatus: document.getElementById('refresh-status'),
    health: document.getElementById('health'),
    lastError: document.getElementById('last-error'),
    overviewMetrics: document.getElementById('overview-metrics'),
    runningFilter: document.getElementById('running-filter'),
    runningRows: document.getElementById('running-rows'),
    retryList: document.getElementById('retry-list'),
    issueInput: document.getElementById('issue-input'),
    issueButton: document.getElementById('issue-button'),
    issueOutput: document.getElementById('issue-output')
  };

  function formatNumber(value) {
    return Number.isFinite(value) ? value.toLocaleString('en-US') : '0';
  }

  function setRefreshStatus(message, isError) {
    elements.refreshStatus.textContent = message;
    elements.refreshStatus.className = isError ? 'status-error' : 'status-ok';
  }

  function renderOverview(payload) {
    const metrics = [
      { label: 'Running', value: payload.counts.running },
      { label: 'Retrying', value: payload.counts.retrying },
      { label: 'Total tokens', value: payload.codex_totals.total_tokens },
      { label: 'Runtime seconds', value: payload.codex_totals.seconds_running }
    ];

    elements.overviewMetrics.replaceChildren(
      ...metrics.map((metric) => {
        const article = document.createElement('article');
        article.className = 'metric';

        const heading = document.createElement('h3');
        heading.textContent = metric.label;

        const value = document.createElement('p');
        value.textContent = formatNumber(metric.value);

        article.append(heading, value);
        return article;
      })
    );

    const healthFailed = payload.health.dispatch_validation === 'failed';
    elements.health.className = healthFailed ? 'health-failed' : 'health-ok';
    elements.health.textContent = 'Dispatch validation: ' + payload.health.dispatch_validation;
    elements.lastError.textContent = payload.health.last_error ? 'Last error: ' + payload.health.last_error : '';
  }

  function renderRunning(payload) {
    const filter = state.filter.toLowerCase();
    const rows = payload.running.filter((entry) => {
      if (!filter) {
        return true;
      }
      return entry.issue_identifier.toLowerCase().includes(filter);
    });

    if (rows.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'muted';
      cell.textContent = 'No matching running issues.';
      row.appendChild(cell);
      elements.runningRows.replaceChildren(row);
      return;
    }

    elements.runningRows.replaceChildren(
      ...rows.map((entry) => {
        const issue = entry.issue_identifier;
        const row = document.createElement('tr');
        row.setAttribute('data-issue', issue);
        row.className = 'running-row' + (state.selectedIssue === issue ? ' selected-row' : '');

        const issueCell = document.createElement('td');
        issueCell.textContent = issue;

        const sessionCell = document.createElement('td');
        sessionCell.textContent = entry.session_id || 'n/a';

        const stateCell = document.createElement('td');
        stateCell.textContent = entry.state;

        const turnsCell = document.createElement('td');
        turnsCell.textContent = formatNumber(entry.turn_count);

        const tokensCell = document.createElement('td');
        tokensCell.textContent = formatNumber(entry.tokens.total_tokens);

        row.append(issueCell, sessionCell, stateCell, turnsCell, tokensCell);
        return row;
      })
    );
  }

  function renderRetry(payload) {
    if (!payload.retrying.length) {
      const item = document.createElement('li');
      item.className = 'muted';
      item.textContent = 'No issues are waiting for retry.';
      elements.retryList.replaceChildren(item);
      return;
    }

    elements.retryList.replaceChildren(
      ...payload.retrying.map((entry) => {
        const item = document.createElement('li');

        const issue = document.createElement('strong');
        issue.textContent = entry.issue_identifier;

        const detail = document.createTextNode(' attempt ' + entry.attempt + ' due ' + entry.due_at);
        item.append(issue, detail);

        if (entry.error) {
          item.append(document.createTextNode(' - ' + entry.error));
        }

        return item;
      })
    );
  }

  async function loadIssue(identifier) {
    if (!identifier) {
      return;
    }

    try {
      const response = await fetch('/api/v1/' + encodeURIComponent(identifier));
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload && payload.error ? payload.error.message : 'Issue request failed');
      }
      state.selectedIssue = identifier;
      elements.issueOutput.textContent = JSON.stringify(payload, null, 2);
      if (state.lastPayload) {
        renderRunning(state.lastPayload);
      }
    } catch (error) {
      elements.issueOutput.textContent = 'Issue load failed: ' + (error instanceof Error ? error.message : String(error));
    }
  }

  async function loadState() {
    try {
      const response = await fetch('/api/v1/state');
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload && payload.error ? payload.error.message : 'State request failed');
      }

      state.lastPayload = payload;
      renderOverview(payload);
      renderRunning(payload);
      renderRetry(payload);
      setRefreshStatus('Live', false);
      state.pollDelayMs = 5000;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRefreshStatus('Polling failed: ' + message, true);
      state.pollDelayMs = Math.min(state.pollDelayMs * 2, 30000);
    } finally {
      clearTimeout(state.pollTimer);
      state.pollTimer = setTimeout(loadState, state.pollDelayMs);
    }
  }

  async function refreshNow() {
    try {
      const response = await fetch('/api/v1/refresh', { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload && payload.error ? payload.error.message : 'Refresh request failed');
      }
      setRefreshStatus(payload.coalesced ? 'Refresh coalesced' : 'Refresh queued', false);
      await loadState();
    } catch (error) {
      setRefreshStatus('Refresh failed: ' + (error instanceof Error ? error.message : String(error)), true);
    }
  }

  function wireEvents() {
    elements.refreshButton.addEventListener('click', refreshNow);
    elements.issueButton.addEventListener('click', () => {
      const identifier = elements.issueInput.value.trim();
      void loadIssue(identifier);
    });

    elements.issueInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        void loadIssue(elements.issueInput.value.trim());
      }
    });

    elements.runningFilter.addEventListener('input', (event) => {
      state.filter = event.target.value || '';
      if (state.lastPayload) {
        renderRunning(state.lastPayload);
      }
    });

    elements.runningRows.addEventListener('click', (event) => {
      const row = event.target && event.target.closest ? event.target.closest('tr[data-issue]') : null;
      if (!row) {
        return;
      }
      const issue = row.getAttribute('data-issue') || '';
      elements.issueInput.value = issue;
      void loadIssue(issue);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && document.activeElement !== elements.runningFilter) {
        event.preventDefault();
        elements.runningFilter.focus();
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        void refreshNow();
      }
    });
  }

  wireEvents();
  void loadState();
})();`;
}

export function renderDashboardStylesCss(): string {
  return `:root {
  --ink: #122018;
  --muted: #5d7062;
  --paper: #f5f7f2;
  --panel: #ffffff;
  --line: #d6ddd3;
  --accent: #1d6250;
  --accent-soft: #dbf0e8;
  --danger: #b13a29;
  --danger-soft: #fdebe8;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  color: var(--ink);
  font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
  background: linear-gradient(140deg, #edf5ed 0%, #f8fbf6 100%);
  min-height: 100vh;
  position: relative;
}

.bg-shape {
  position: fixed;
  width: 280px;
  height: 280px;
  border-radius: 999px;
  filter: blur(40px);
  opacity: 0.25;
  pointer-events: none;
}

.bg-shape-a {
  top: -80px;
  right: -60px;
  background: #9dd9c2;
}

.bg-shape-b {
  bottom: -80px;
  left: -60px;
  background: #c5d8f7;
}

.topbar {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(6px);
  position: sticky;
  top: 0;
  z-index: 2;
}

.eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 11px;
  color: var(--muted);
  margin: 0;
}

h1 {
  margin: 2px 0 0;
  font-size: 26px;
  font-family: "IBM Plex Serif", "Palatino", serif;
}

h2 {
  margin: 0;
  font-size: 18px;
  font-family: "IBM Plex Serif", "Palatino", serif;
}

h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.topbar-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}

button {
  border: 0;
  border-radius: 8px;
  padding: 9px 14px;
  background: var(--accent);
  color: white;
  font-weight: 600;
  cursor: pointer;
}

button:hover {
  filter: brightness(1.05);
}

input {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  background: #fff;
}

.layout {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 14px;
  padding: 18px 24px 28px;
}

.panel {
  grid-column: span 6;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  padding: 14px;
  box-shadow: 0 8px 24px rgba(19, 32, 21, 0.05);
}

.panel-wide {
  grid-column: span 12;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
  margin-bottom: 10px;
}

.inline-form {
  display: flex;
  gap: 8px;
}

.metric-grid {
  margin-top: 10px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}

.metric {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px;
  background: #fbfdf9;
}

.metric p {
  margin: 6px 0 0;
  font-size: 22px;
  font-family: "IBM Plex Serif", "Palatino", serif;
}

.health-ok {
  color: var(--accent);
  background: var(--accent-soft);
  padding: 8px;
  border-radius: 8px;
  margin: 10px 0 0;
}

.health-failed {
  color: var(--danger);
  background: var(--danger-soft);
  padding: 8px;
  border-radius: 8px;
  margin: 10px 0 0;
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

.table-wrap {
  overflow: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid var(--line);
  font-size: 14px;
}

.running-row {
  cursor: pointer;
}

.running-row:hover {
  background: #f4f9f5;
}

.running-row.selected-row {
  background: #e7f4ec;
}

.list {
  margin: 10px 0 0;
  padding-left: 18px;
}

.code {
  margin: 10px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  background: #f5f9f4;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px;
  max-height: 320px;
  overflow: auto;
}

@media (max-width: 980px) {
  .panel {
    grid-column: span 12;
  }

  .topbar {
    position: static;
    flex-direction: column;
  }

  .topbar-actions {
    width: 100%;
    justify-content: space-between;
  }

  .panel-head {
    flex-direction: column;
    align-items: flex-start;
  }
}`;
}
