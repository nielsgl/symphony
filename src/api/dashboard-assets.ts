interface DashboardClientConfig {
  dashboard_enabled: boolean;
  refresh_ms: number;
  render_interval_ms: number;
  phase_stale_warn_ms?: number;
}

export function renderDashboardHtml(_config?: DashboardClientConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Symphony Operator Control</title>
  <link rel="stylesheet" href="/dashboard/styles.css" />
  <script src="/dashboard/client.js" defer></script>
</head>
<body>
  <div class="backdrop"></div>
  <header class="hero">
    <div class="hero-copy">
      <p class="eyebrow">Symphony Runtime</p>
      <h1>Operator Control Surface</h1>
      <p class="hero-subtitle">Live orchestration visibility with retry control, issue drilldown, and desktop/browser parity.</p>
    </div>
    <div class="hero-status-card">
      <div class="status-row">
        <span id="connection-badge" class="badge badge-live">Live</span>
        <span id="connection-detail" class="muted">Streaming updates connected</span>
      </div>
      <p id="last-updated" class="muted">Last update: --</p>
      <div class="hero-actions">
        <button id="refresh-button" class="refresh-now-button" type="button">Refresh Now</button>
        <span id="refresh-status" aria-live="polite"></span>
      </div>
    </div>
  </header>

  <main class="layout">
    <section id="snapshot-error-panel" class="panel panel-wide snapshot-error hidden">
      <div class="panel-head">
        <h2>Snapshot Unavailable</h2>
      </div>
      <p id="snapshot-error-message" class="muted">Snapshot unavailable.</p>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Runtime Overview</h2>
      </div>
      <p id="health-message" class="health health-ok">Dispatch validation: ok</p>
      <p id="last-error" class="muted"></p>
      <div id="kpi-grid" class="kpi-grid"></div>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Rate Limits</h2>
      </div>
      <pre id="rate-limits" class="code-block">No rate limits reported.</pre>
    </section>

    <section class="panel panel-wide">
      <details id="throughput-panel" open>
        <summary>Throughput</summary>
        <pre id="throughput-output" class="code-block">No throughput samples yet.</pre>
      </details>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Runtime Resolution</h2>
      </div>
      <pre id="runtime-resolution-output" class="code-block">Runtime resolution unavailable.</pre>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Running Sessions</h2>
        <div class="toolbar">
          <select id="status-filter" aria-label="Status filter">
            <option value="all">All</option>
            <option value="running">Running</option>
            <option value="retrying">Retrying</option>
            <option value="blocked">Blocked</option>
          </select>
          <input id="running-filter" type="search" placeholder="Filter issues (/)" aria-label="Filter running issues" />
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>State</th>
              <th>Session</th>
              <th>Phase</th>
              <th>Runtime</th>
              <th>Turns</th>
              <th>Tokens</th>
              <th>Last Event</th>
              <th>Last Message</th>
              <th>Last Event At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="running-rows">
            <tr><td colspan="11" class="muted">No running issues.</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Retry Queue</h2>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Attempt</th>
              <th>Due At</th>
              <th>Host</th>
              <th>Workspace</th>
              <th>Provisioning</th>
              <th>Stop Reason</th>
              <th>Previous Session</th>
              <th>Error</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="retry-rows">
            <tr><td colspan="10" class="muted">No issues are waiting for retry.</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel panel-wide">
      <div class="panel-head">
        <h2>Blocked Input Required</h2>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Attempt</th>
              <th>Blocked At</th>
              <th>Host</th>
              <th>Workspace</th>
              <th>Stop Reason</th>
              <th>Previous Session</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="blocked-rows">
            <tr><td colspan="8" class="muted">No issues are blocked on operator input.</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel panel-wide">
      <details id="issue-panel" open>
        <summary>Issue Detail</summary>
        <div class="issue-detail">
          <div class="inline-form">
            <input id="issue-input" type="text" placeholder="ABC-123" aria-label="Issue identifier" />
            <button id="issue-load" type="button">Load</button>
            <button id="issue-open-json" type="button">Open JSON</button>
          </div>
          <p id="issue-summary" class="muted">No issue selected.</p>
          <pre id="issue-output" class="code-block">Select a running issue or enter an issue identifier.</pre>
        </div>
      </details>
    </section>

    <section class="panel panel-wide">
      <details id="runtime-events-panel" open>
        <summary>Runtime Event Feed</summary>
        <div class="toolbar">
          <select id="event-feed-filter" aria-label="Runtime event severity filter">
            <option value="all">All</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </div>
        <ul id="runtime-events-list" class="list">
          <li class="muted">No runtime events.</li>
        </ul>
      </details>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Diagnostics</h2>
      </div>
      <pre id="diagnostics-output" class="code-block">Diagnostics unavailable.</pre>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Recent Runs</h2>
      </div>
      <ul id="history-list" class="list">
        <li class="muted">No run history available.</li>
      </ul>
    </section>
  </main>
</body>
</html>`;
}

export function renderDashboardClientJs(config: DashboardClientConfig = {
  dashboard_enabled: true,
  refresh_ms: 4000,
  render_interval_ms: 1000
}): string {
  const safeConfig = {
    dashboard_enabled: config.dashboard_enabled !== false,
    refresh_ms: Math.max(500, Number(config.refresh_ms) || 4000),
    render_interval_ms: Math.max(250, Number(config.render_interval_ms) || 1000),
    phase_stale_warn_ms: Math.max(1000, Number(config.phase_stale_warn_ms) || 45000)
  };
  return `(() => {
  const DASHBOARD_CONFIG = ${JSON.stringify(safeConfig)};
  const state = {
    payload: null,
    lastGoodPayload: null,
    selectedIssue: '',
    connection: 'offline',
    pollTimer: null,
    runtimeTicker: null,
    pollDelayMs: DASHBOARD_CONFIG.refresh_ms,
    streamRetryMs: 1000,
    streamConnected: false,
    eventSource: null,
    uiStateLoaded: false,
    uiStateSaveTimer: null,
    filter: {
      query: '',
      status: 'all',
      eventFeedSeverity: 'all'
    },
    panels: {
      throughputOpen: true,
      runtimeEventsOpen: true
    },
    runtimeResolution: null
  };

  const elements = {
    connectionBadge: document.getElementById('connection-badge'),
    connectionDetail: document.getElementById('connection-detail'),
    lastUpdated: document.getElementById('last-updated'),
    refreshButton: document.getElementById('refresh-button'),
    refreshStatus: document.getElementById('refresh-status'),
    healthMessage: document.getElementById('health-message'),
    lastError: document.getElementById('last-error'),
    snapshotErrorPanel: document.getElementById('snapshot-error-panel'),
    snapshotErrorMessage: document.getElementById('snapshot-error-message'),
    kpiGrid: document.getElementById('kpi-grid'),
    rateLimits: document.getElementById('rate-limits'),
    throughputPanel: document.getElementById('throughput-panel'),
    throughputOutput: document.getElementById('throughput-output'),
    runtimeResolutionOutput: document.getElementById('runtime-resolution-output'),
    runningRows: document.getElementById('running-rows'),
    retryRows: document.getElementById('retry-rows'),
    blockedRows: document.getElementById('blocked-rows'),
    statusFilter: document.getElementById('status-filter'),
    runningFilter: document.getElementById('running-filter'),
    issuePanel: document.getElementById('issue-panel'),
    issueInput: document.getElementById('issue-input'),
    issueLoad: document.getElementById('issue-load'),
    issueOpenJson: document.getElementById('issue-open-json'),
    issueSummary: document.getElementById('issue-summary'),
    issueOutput: document.getElementById('issue-output'),
    runtimeEventsPanel: document.getElementById('runtime-events-panel'),
    eventFeedFilter: document.getElementById('event-feed-filter'),
    runtimeEventsList: document.getElementById('runtime-events-list'),
    diagnosticsOutput: document.getElementById('diagnostics-output'),
    historyList: document.getElementById('history-list')
  };

  function formatNumber(value) {
    if (!Number.isFinite(value)) {
      return '0';
    }
    return value.toLocaleString('en-US');
  }

  function formatDate(value) {
    if (!value) {
      return 'n/a';
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return String(value);
    }
    return new Date(parsed).toLocaleString();
  }

  function formatDurationFromIso(iso) {
    const parsed = Date.parse(iso || '');
    if (!Number.isFinite(parsed)) {
      return 'n/a';
    }
    const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remain = seconds % 60;
    return minutes + 'm ' + remain + 's';
  }

  function setConnectionStatus(mode, detail) {
    state.connection = mode;
    elements.connectionBadge.textContent = mode === 'live' ? 'Live' : 'Offline';
    elements.connectionBadge.className = mode === 'live' ? 'badge badge-live' : 'badge badge-offline';
    elements.connectionDetail.textContent = detail;
  }

  function setLastUpdated(value) {
    elements.lastUpdated.textContent = 'Last update: ' + formatDate(value);
  }

  function setRefreshStatus(message, isError) {
    elements.refreshStatus.textContent = message;
    elements.refreshStatus.className = isError ? 'status-error' : 'status-ok';
  }

  function createMetricCard(label, value) {
    const card = document.createElement('article');
    card.className = 'kpi-card';
    const title = document.createElement('h3');
    title.textContent = label;
    const number = document.createElement('p');
    number.textContent = value;
    card.append(title, number);
    return card;
  }

  function computeDisplayRuntimeSeconds(payload) {
    if (!payload || !payload.codex_totals) {
      return 0;
    }
    const base = Number(payload.codex_totals.seconds_running) || 0;
    const generatedAtMs = Date.parse(payload.generated_at || '');
    if (!Number.isFinite(generatedAtMs)) {
      return base;
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - generatedAtMs) / 1000));
    return base + elapsed;
  }

  function renderOverview(payload) {
    elements.kpiGrid.replaceChildren(
      createMetricCard('Running', formatNumber(payload.counts.running)),
      createMetricCard('Retrying', formatNumber(payload.counts.retrying)),
      createMetricCard('Blocked', formatNumber(payload.counts.blocked)),
      createMetricCard('Total Tokens', formatNumber(payload.codex_totals.total_tokens)),
      createMetricCard('Input Tokens', formatNumber(payload.codex_totals.input_tokens)),
      createMetricCard('Output Tokens', formatNumber(payload.codex_totals.output_tokens)),
      createMetricCard('Runtime Seconds', formatNumber(computeDisplayRuntimeSeconds(payload)))
    );

    const failed = payload.health.dispatch_validation === 'failed';
    elements.healthMessage.className = failed ? 'health health-failed' : 'health health-ok';
    elements.healthMessage.textContent = 'Dispatch validation: ' + payload.health.dispatch_validation;
    elements.lastError.textContent = payload.health.last_error ? 'Last error: ' + payload.health.last_error : '';

    const rateLimits = payload.rate_limits;
    elements.rateLimits.textContent = rateLimits ? JSON.stringify(rateLimits, null, 2) : 'No rate limits reported.';
  }

  function renderThroughput(payload) {
    if (!payload || !payload.throughput) {
      elements.throughputOutput.textContent = 'No throughput samples yet.';
      return;
    }

    const throughput = payload.throughput;
    const sparkline = Array.isArray(throughput.sparkline_10m) ? throughput.sparkline_10m : [];
    elements.throughputOutput.textContent = JSON.stringify(
      {
        current_tps: throughput.current_tps,
        avg_tps_60s: throughput.avg_tps_60s,
        sample_count: throughput.sample_count,
        window_seconds: throughput.window_seconds,
        sparkline_10m: sparkline
      },
      null,
      2
    );
  }

  function renderRuntimeResolution(runtimeResolution) {
    if (!runtimeResolution) {
      elements.runtimeResolutionOutput.textContent = 'Runtime resolution unavailable.';
      return;
    }

    elements.runtimeResolutionOutput.textContent = JSON.stringify(runtimeResolution, null, 2);
  }

  function renderRuntimeEvents(payload) {
    const events = Array.isArray(payload && payload.recent_runtime_events) ? payload.recent_runtime_events : [];
    const filtered = events.filter(function (entry) {
      if (state.filter.eventFeedSeverity === 'all') {
        return true;
      }
      return entry && entry.severity === state.filter.eventFeedSeverity;
    });

    if (!filtered.length) {
      const empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'No runtime events.';
      elements.runtimeEventsList.replaceChildren(empty);
      return;
    }

    const nodes = filtered.map(function (entry) {
      const item = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = '[' + (entry.severity || 'info') + '] ' + (entry.event || 'unknown');
      const meta = document.createElement('span');
      const issue = entry.issue_identifier ? ' • issue ' + entry.issue_identifier : '';
      const session = entry.session_id ? ' • session ' + entry.session_id : '';
      const detail = entry.detail ? ' • ' + entry.detail : '';
      meta.textContent = formatDate(entry.at) + issue + session + detail;
      item.append(title, meta);
      return item;
    });

    elements.runtimeEventsList.replaceChildren(...nodes);
  }

  function renderSnapshotError(errorPayload) {
    elements.snapshotErrorPanel.classList.remove('hidden');
    elements.snapshotErrorMessage.textContent =
      (errorPayload && errorPayload.code ? String(errorPayload.code) + ': ' : '') +
      (errorPayload && errorPayload.message ? String(errorPayload.message) : 'Snapshot unavailable.');
    if (!state.lastGoodPayload) {
      elements.kpiGrid.replaceChildren();
      elements.rateLimits.textContent = 'n/a';
      const emptyRunningRow = document.createElement('tr');
      const runningCell = document.createElement('td');
      runningCell.colSpan = 10;
      runningCell.className = 'muted';
      runningCell.textContent = 'No running issues while snapshot is unavailable.';
      emptyRunningRow.appendChild(runningCell);
      elements.runningRows.replaceChildren(emptyRunningRow);

      const emptyRetryRow = document.createElement('tr');
      const retryCell = document.createElement('td');
      retryCell.colSpan = 10;
      retryCell.className = 'muted';
      retryCell.textContent = 'No retry data while snapshot is unavailable.';
      emptyRetryRow.appendChild(retryCell);
      elements.retryRows.replaceChildren(emptyRetryRow);

      const emptyBlockedRow = document.createElement('tr');
      const blockedCell = document.createElement('td');
      blockedCell.colSpan = 8;
      blockedCell.className = 'muted';
      blockedCell.textContent = 'No blocked-input data while snapshot is unavailable.';
      emptyBlockedRow.appendChild(blockedCell);
      elements.blockedRows.replaceChildren(emptyBlockedRow);
      return;
    }

    // Keep stale-but-last-known-good data visible while snapshot fetch is degraded.
    renderOverview(state.lastGoodPayload);
    renderThroughput(state.lastGoodPayload);
    renderRunning(state.lastGoodPayload);
    renderRetry(state.lastGoodPayload);
    renderBlocked(state.lastGoodPayload);
    renderRuntimeEvents(state.lastGoodPayload);
  }

  function clearSnapshotError() {
    elements.snapshotErrorPanel.classList.add('hidden');
    elements.snapshotErrorMessage.textContent = 'Snapshot unavailable.';
  }

  function createStateBadge(stateValue) {
    const badge = document.createElement('span');
    badge.className = 'state-badge';
    const normalized = String(stateValue || '').toLowerCase();
    if (normalized.includes('progress') || normalized.includes('running')) {
      badge.classList.add('state-active');
    } else if (normalized.includes('todo') || normalized.includes('backlog')) {
      badge.classList.add('state-idle');
    } else if (normalized.includes('done') || normalized.includes('closed')) {
      badge.classList.add('state-terminal');
    } else {
      badge.classList.add('state-neutral');
    }
    badge.textContent = stateValue || 'unknown';
    return badge;
  }

  function createProvisioningBadge(label, ok) {
    const badge = document.createElement('span');
    badge.className = 'mini-badge ' + (ok ? 'mini-badge-good' : 'mini-badge-bad');
    badge.textContent = label + ': ' + (ok ? 'yes' : 'no');
    return badge;
  }

  function formatInputDecisionContext(detail) {
    if (!detail) {
      return null;
    }
    if (detail.includes('input_required_unanswerable')) {
      return 'Input handling: unanswerable schema (manual resume required)';
    }
    if (detail.includes('non_interactive_fallback')) {
      return 'Input handling: non-interactive fallback answer';
    }
    if (detail.includes('approval_option_permissive')) {
      return 'Input handling: permissive approval option selected';
    }
    if (detail.includes('approval_option_exact')) {
      return 'Input handling: exact approval option selected';
    }
    return null;
  }

  function createActionButton(text, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  async function copyText(value) {
    if (!value) {
      setRefreshStatus('No value to copy', true);
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const helper = document.createElement('textarea');
        helper.value = value;
        helper.setAttribute('readonly', 'readonly');
        helper.style.position = 'absolute';
        helper.style.left = '-9999px';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        document.body.removeChild(helper);
      }
      setRefreshStatus('Copied: ' + value, false);
    } catch (error) {
      setRefreshStatus('Copy failed: ' + String(error), true);
    }
  }

  function rowMatchesFilter(entry) {
    if (state.filter.status === 'running' && entry.state.toLowerCase().includes('retry')) {
      return false;
    }
    if (state.filter.status === 'retrying' && !entry.state.toLowerCase().includes('retry')) {
      return false;
    }
    if (state.filter.status === 'blocked') {
      return false;
    }
    if (!state.filter.query) {
      return true;
    }
    return entry.issue_identifier.toLowerCase().includes(state.filter.query.toLowerCase());
  }

  function renderRunning(payload) {
    const rows = payload.running.filter(rowMatchesFilter);
    if (!rows.length) {
      const emptyRow = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 11;
      cell.className = 'muted';
      cell.textContent = 'No running issues match current filters.';
      emptyRow.appendChild(cell);
      elements.runningRows.replaceChildren(emptyRow);
      return;
    }

    const nodes = rows.map((entry) => {
      const row = document.createElement('tr');
      row.setAttribute('data-issue', entry.issue_identifier);
      if (state.selectedIssue === entry.issue_identifier) {
        row.classList.add('selected-row');
      }

      const issueCell = document.createElement('td');
      issueCell.textContent = entry.issue_identifier;

      const stateCell = document.createElement('td');
      stateCell.appendChild(createStateBadge(entry.state));

      const sessionCell = document.createElement('td');
      const sessionValue = document.createElement('div');
      sessionValue.textContent = entry.session_id || 'n/a';
      const sessionMeta = document.createElement('div');
      sessionMeta.className = 'muted';
      const sessionMetaParts = [];
      if (entry.worker_host) {
        sessionMetaParts.push('Host ' + entry.worker_host);
      }
      if (entry.workspace_path) {
        sessionMetaParts.push(entry.workspace_path);
      }
      if (entry.provisioner_type) {
        sessionMetaParts.push('Provisioner ' + entry.provisioner_type);
      }
      if (entry.branch_name) {
        sessionMetaParts.push('Branch ' + entry.branch_name);
      }
      if (entry.workspace_git_status) {
        sessionMetaParts.push('Git ' + entry.workspace_git_status);
      }
      sessionMeta.textContent = sessionMetaParts.length ? sessionMetaParts.join(' • ') : 'Host n/a';
      sessionCell.append(sessionValue, sessionMeta);

      const phaseCell = document.createElement('td');
      const phaseLabel = document.createElement('div');
      phaseLabel.textContent = entry.current_phase || 'n/a';
      const phaseMeta = document.createElement('div');
      phaseMeta.className = 'muted';
      if (entry.current_phase_at) {
        const phaseAgeMs = Date.now() - Date.parse(entry.current_phase_at);
        const stale = Number.isFinite(phaseAgeMs) && phaseAgeMs > DASHBOARD_CONFIG.phase_stale_warn_ms;
        phaseMeta.textContent = (entry.phase_elapsed_ms ? 'elapsed ' + Math.floor(entry.phase_elapsed_ms / 1000) + 's' : 'elapsed n/a') + ' • updated ' + formatDurationFromIso(entry.current_phase_at) + ' ago' + (stale ? ' • No phase movement yet' : '');
      } else {
        phaseMeta.textContent = 'No phase movement yet';
      }
      phaseCell.append(phaseLabel, phaseMeta);

      const runtimeCell = document.createElement('td');
      runtimeCell.className = 'runtime-cell';
      runtimeCell.setAttribute('data-started-at', entry.started_at);
      runtimeCell.textContent = formatDurationFromIso(entry.started_at);

      const turnsCell = document.createElement('td');
      turnsCell.textContent = formatNumber(entry.turn_count);

      const tokensCell = document.createElement('td');
      const tokenTotal = document.createElement('div');
      tokenTotal.textContent = 'Total: ' + formatNumber(entry.tokens.total_tokens);
      const tokenDetail = document.createElement('div');
      tokenDetail.className = 'muted';
      tokenDetail.textContent = 'In ' + formatNumber(entry.tokens.input_tokens) + ' / Out ' + formatNumber(entry.tokens.output_tokens);
      tokensCell.append(tokenTotal, tokenDetail);

      const eventCell = document.createElement('td');
      eventCell.textContent = entry.last_event_summary || entry.last_event || 'n/a';

      const messageCell = document.createElement('td');
      messageCell.textContent = entry.last_message || 'n/a';

      const lastEventAtCell = document.createElement('td');
      lastEventAtCell.textContent = formatDate(entry.last_event_at);

      const actionsCell = document.createElement('td');
      actionsCell.className = 'action-cell';
      const copySession = createActionButton('Copy Session', 'ghost-button', function () {
        copyText(entry.session_id || '');
      });
      const copyThreadTurn = createActionButton('Copy Thread/Turn', 'ghost-button', function () {
        if (entry.thread_id && entry.turn_id) {
          copyText(entry.thread_id + '/' + entry.turn_id);
          return;
        }
        setRefreshStatus('Thread/turn id unavailable', true);
      });
      const openJson = createActionButton('JSON', 'ghost-button', function () {
        window.open('/api/v1/' + encodeURIComponent(entry.issue_identifier), '_blank', 'noopener');
      });
      actionsCell.append(copySession, copyThreadTurn, openJson);

      row.append(
        issueCell,
        stateCell,
        sessionCell,
        phaseCell,
        runtimeCell,
        turnsCell,
        tokensCell,
        eventCell,
        messageCell,
        lastEventAtCell,
        actionsCell
      );

      row.addEventListener('click', function () {
        elements.issueInput.value = entry.issue_identifier;
        void loadIssue(entry.issue_identifier);
      });

      return row;
    });

    elements.runningRows.replaceChildren(...nodes);
  }

  function renderRetry(payload) {
    const rows = payload.retrying.filter(function (entry) {
      if (state.filter.status === 'running' || state.filter.status === 'blocked') {
        return false;
      }
      if (!state.filter.query) {
        return true;
      }
      return entry.issue_identifier.toLowerCase().includes(state.filter.query.toLowerCase());
    });

    if (!rows.length) {
      const emptyRow = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 10;
      cell.className = 'muted';
      cell.textContent =
        state.filter.status === 'retrying'
          ? 'No retrying issues match current filters.'
          : 'No issues are waiting for retry.';
      emptyRow.appendChild(cell);
      elements.retryRows.replaceChildren(emptyRow);
      return;
    }

    const nodes = rows.map((entry) => {
      const row = document.createElement('tr');

      const issueCell = document.createElement('td');
      issueCell.textContent = entry.issue_identifier;

      const attemptCell = document.createElement('td');
      attemptCell.textContent = formatNumber(entry.attempt);

      const dueAtCell = document.createElement('td');
      dueAtCell.textContent = formatDate(entry.due_at);

      const errorCell = document.createElement('td');
      errorCell.textContent = entry.error || 'n/a';

      const hostCell = document.createElement('td');
      hostCell.textContent = entry.worker_host || 'n/a';

      const workspaceCell = document.createElement('td');
      workspaceCell.textContent = entry.workspace_path || 'n/a';

      const provisioningCell = document.createElement('td');
      const provisioningType = document.createElement('div');
      provisioningType.textContent = entry.provisioner_type || 'n/a';
      const provisioningDetail = document.createElement('div');
      provisioningDetail.className = 'muted';
      const provisioningParts = [];
      if (entry.branch_name) {
        provisioningParts.push('Branch ' + entry.branch_name);
      }
      if (entry.workspace_git_status) {
        provisioningParts.push('Git ' + entry.workspace_git_status);
      }
      if (entry.workspace_exists === false) {
        provisioningParts.push('Missing workspace');
      }
      provisioningDetail.textContent = provisioningParts.length ? provisioningParts.join(' • ') : 'n/a';
      const provisioningFlags = document.createElement('div');
      provisioningFlags.className = 'inline-badges';
      provisioningFlags.append(
        createProvisioningBadge('Provisioned', Boolean(entry.workspace_provisioned)),
        createProvisioningBadge('Git worktree', Boolean(entry.workspace_is_git_worktree))
      );
      provisioningCell.append(provisioningType, provisioningDetail, provisioningFlags);

      const stopReasonCell = document.createElement('td');
      const stopReasonCode = document.createElement('div');
      stopReasonCode.textContent = entry.stop_reason_code || 'n/a';
      const stopReasonDetail = document.createElement('div');
      stopReasonDetail.className = 'muted';
      stopReasonDetail.textContent = entry.stop_reason_detail || 'n/a';
      stopReasonCell.append(stopReasonCode, stopReasonDetail);
      const lastPhaseLine = document.createElement('div');
      lastPhaseLine.className = 'muted';
      lastPhaseLine.textContent = 'Last phase: ' + (entry.last_phase || 'n/a') + (entry.last_phase_at ? ' @ ' + formatDate(entry.last_phase_at) : '');
      stopReasonCell.append(lastPhaseLine);
      if (entry.last_phase_detail) {
        const lastPhaseDetailLine = document.createElement('div');
        lastPhaseDetailLine.className = 'muted';
        lastPhaseDetailLine.textContent = entry.last_phase_detail;
        stopReasonCell.append(lastPhaseDetailLine);
      }
      const inputDecision = formatInputDecisionContext(entry.stop_reason_detail || '');
      if (inputDecision) {
        const decisionLine = document.createElement('div');
        decisionLine.className = 'muted';
        decisionLine.textContent = inputDecision;
        stopReasonCell.append(decisionLine);
      }

      const previousSessionCell = document.createElement('td');
      const previousSessionValue = document.createElement('div');
      previousSessionValue.textContent = entry.previous_session_id || 'n/a';
      const previousThreadValue = document.createElement('div');
      previousThreadValue.className = 'muted';
      previousThreadValue.textContent = entry.previous_thread_id ? 'Thread ' + entry.previous_thread_id : 'Thread n/a';
      previousSessionCell.append(previousSessionValue, previousThreadValue);

      const actionsCell = document.createElement('td');
      const copyPreviousSession = createActionButton('Copy Prev Session', 'ghost-button', function () {
        copyText(entry.previous_session_id || '');
      });
      const copyPreviousThread = createActionButton('Copy Prev Thread', 'ghost-button', function () {
        copyText(entry.previous_thread_id || '');
      });
      const openJson = createActionButton('JSON', 'ghost-button', function () {
        window.open('/api/v1/' + encodeURIComponent(entry.issue_identifier), '_blank', 'noopener');
      });
      actionsCell.append(copyPreviousSession, copyPreviousThread, openJson);

      row.append(
        issueCell,
        attemptCell,
        dueAtCell,
        hostCell,
        workspaceCell,
        provisioningCell,
        stopReasonCell,
        previousSessionCell,
        errorCell,
        actionsCell
      );
      return row;
    });

    elements.retryRows.replaceChildren(...nodes);
  }

  function renderBlocked(payload) {
    const rows = (payload.blocked || []).filter(function (entry) {
      if (state.filter.status === 'running' || state.filter.status === 'retrying') {
        return false;
      }
      if (!state.filter.query) {
        return true;
      }
      return entry.issue_identifier.toLowerCase().includes(state.filter.query.toLowerCase());
    });

    if (!rows.length) {
      const emptyRow = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 8;
      cell.className = 'muted';
      cell.textContent =
        state.filter.status === 'blocked'
          ? 'No blocked issues match current filters.'
          : 'No issues are blocked on operator input.';
      emptyRow.appendChild(cell);
      elements.blockedRows.replaceChildren(emptyRow);
      return;
    }

    const nodes = rows.map((entry) => {
      const row = document.createElement('tr');

      const issueCell = document.createElement('td');
      issueCell.textContent = entry.issue_identifier;

      const attemptCell = document.createElement('td');
      attemptCell.textContent = formatNumber(entry.attempt);

      const blockedAtCell = document.createElement('td');
      blockedAtCell.textContent = formatDate(entry.blocked_at);

      const hostCell = document.createElement('td');
      hostCell.textContent = entry.worker_host || 'n/a';

      const workspaceCell = document.createElement('td');
      workspaceCell.textContent = entry.workspace_path || 'n/a';
      const provisioningFlags = document.createElement('div');
      provisioningFlags.className = 'inline-badges';
      provisioningFlags.append(
        createProvisioningBadge('Provisioned', Boolean(entry.workspace_provisioned)),
        createProvisioningBadge('Git worktree', Boolean(entry.workspace_is_git_worktree))
      );
      workspaceCell.append(provisioningFlags);

      const stopReasonCell = document.createElement('td');
      const stopReasonCode = document.createElement('div');
      stopReasonCode.textContent = entry.stop_reason_code || 'n/a';
      const stopReasonDetail = document.createElement('div');
      stopReasonDetail.className = 'muted';
      stopReasonDetail.textContent = entry.stop_reason_detail || 'n/a';
      stopReasonCell.append(stopReasonCode, stopReasonDetail);
      const lastPhaseLine = document.createElement('div');
      lastPhaseLine.className = 'muted';
      lastPhaseLine.textContent = 'Last phase: ' + (entry.last_phase || 'n/a') + (entry.last_phase_at ? ' @ ' + formatDate(entry.last_phase_at) : '');
      stopReasonCell.append(lastPhaseLine);
      if (entry.last_phase_detail) {
        const lastPhaseDetailLine = document.createElement('div');
        lastPhaseDetailLine.className = 'muted';
        lastPhaseDetailLine.textContent = entry.last_phase_detail;
        stopReasonCell.append(lastPhaseDetailLine);
      }
      const inputDecision = formatInputDecisionContext(entry.stop_reason_detail || '');
      if (inputDecision) {
        const decisionLine = document.createElement('div');
        decisionLine.className = 'muted';
        decisionLine.textContent = inputDecision;
        stopReasonCell.append(decisionLine);
      }

      const previousSessionCell = document.createElement('td');
      const previousSessionValue = document.createElement('div');
      previousSessionValue.textContent = entry.previous_session_id || 'n/a';
      const previousThreadValue = document.createElement('div');
      previousThreadValue.className = 'muted';
      previousThreadValue.textContent = entry.previous_thread_id ? 'Thread ' + entry.previous_thread_id : 'Thread n/a';
      previousSessionCell.append(previousSessionValue, previousThreadValue);

      const actionsCell = document.createElement('td');
      const resumeButton = createActionButton('Resume', 'ghost-button', function () {
        void resumeBlockedIssue(entry.issue_identifier);
      });
      const copyPreviousSession = createActionButton('Copy Prev Session', 'ghost-button', function () {
        copyText(entry.previous_session_id || '');
      });
      const copyWorkspace = createActionButton('Copy Workspace', 'ghost-button', function () {
        copyText(entry.workspace_path || '');
      });
      const openJson = createActionButton('JSON', 'ghost-button', function () {
        window.open('/api/v1/' + encodeURIComponent(entry.issue_identifier), '_blank', 'noopener');
      });
      actionsCell.append(resumeButton, copyPreviousSession, copyWorkspace, openJson);

      row.append(
        issueCell,
        attemptCell,
        blockedAtCell,
        hostCell,
        workspaceCell,
        stopReasonCell,
        previousSessionCell,
        actionsCell
      );
      return row;
    });

    elements.blockedRows.replaceChildren(...nodes);
  }

  function applyPayload(payload, source) {
    if (payload && payload.error) {
      renderSnapshotError(payload.error);
      setLastUpdated(payload.generated_at || new Date().toISOString());
      return;
    }

    clearSnapshotError();
    state.payload = payload;
    state.lastGoodPayload = payload;
    renderOverview(payload);
    renderThroughput(payload);
    renderRunning(payload);
    renderRetry(payload);
    renderBlocked(payload);
    renderRuntimeEvents(payload);
    setLastUpdated(payload.generated_at || new Date().toISOString());
    if (source === 'stream') {
      setConnectionStatus('live', 'Streaming updates connected');
      state.pollDelayMs = DASHBOARD_CONFIG.refresh_ms;
    }
  }

  function updateRuntimeClock() {
    if (state.lastGoodPayload) {
      renderOverview(state.lastGoodPayload);
    }
    const runtimeCells = document.querySelectorAll('.runtime-cell');
    for (const runtimeCell of runtimeCells) {
      const startedAt = runtimeCell.getAttribute('data-started-at');
      runtimeCell.textContent = formatDurationFromIso(startedAt);
    }
  }

  async function fetchJson(url, init) {
    const response = await fetch(url, init);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload && payload.error ? payload.error.message : 'Request failed');
    }
    return payload;
  }

  async function loadStateViaPoll() {
    try {
      const payload = await fetchJson('/api/v1/state');
      applyPayload(payload, 'poll');
      setConnectionStatus(state.streamConnected ? 'live' : 'offline', state.streamConnected ? 'Streaming updates connected' : 'Polling fallback active');
      state.pollDelayMs = DASHBOARD_CONFIG.refresh_ms;
    } catch (error) {
      setConnectionStatus('offline', 'Polling failed');
      setRefreshStatus('Polling failed: ' + String(error), true);
      state.pollDelayMs = Math.min(state.pollDelayMs * 2, 30000);
    } finally {
      clearTimeout(state.pollTimer);
      state.pollTimer = setTimeout(loadStateViaPoll, state.pollDelayMs);
    }
  }

  function scheduleStateSave() {
    if (!state.uiStateLoaded) {
      return;
    }

    clearTimeout(state.uiStateSaveTimer);
    state.uiStateSaveTimer = setTimeout(async function () {
      try {
        await fetch('/api/v1/ui-state', {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            state: {
              selected_issue: state.selectedIssue || null,
              filters: {
                status: state.filter.status,
                query: state.filter.query
              },
              event_feed_filter: state.filter.eventFeedSeverity,
              panels: {
                throughput_open: !!elements.throughputPanel.open,
                runtime_events_open: !!elements.runtimeEventsPanel.open
              },
              panel_state: {
                issue_detail_open: !!elements.issuePanel.open
              }
            }
          })
        });
      } catch {
        // Keep UI responsive; persistence failures are non-fatal.
      }
    }, 250);
  }

  async function loadUiState() {
    try {
      const response = await fetch('/api/v1/ui-state');
      if (!response.ok) {
        state.uiStateLoaded = true;
        return;
      }
      const payload = await response.json();
      const restored = payload.state;
      if (!restored) {
        state.uiStateLoaded = true;
        return;
      }

      state.selectedIssue = restored.selected_issue || '';
      state.filter.query = restored.filters && restored.filters.query ? restored.filters.query : '';
      state.filter.status = restored.filters && restored.filters.status ? restored.filters.status : 'all';
      state.filter.eventFeedSeverity = restored.event_feed_filter || 'all';
      state.panels.throughputOpen =
        restored.panels && typeof restored.panels.throughput_open === 'boolean' ? restored.panels.throughput_open : true;
      state.panels.runtimeEventsOpen =
        restored.panels && typeof restored.panels.runtime_events_open === 'boolean'
          ? restored.panels.runtime_events_open
          : true;

      elements.issueInput.value = state.selectedIssue;
      elements.runningFilter.value = state.filter.query;
      elements.statusFilter.value = state.filter.status;
      elements.eventFeedFilter.value = state.filter.eventFeedSeverity;
      elements.throughputPanel.open = state.panels.throughputOpen;
      elements.runtimeEventsPanel.open = state.panels.runtimeEventsOpen;
      if (restored.panel_state && typeof restored.panel_state.issue_detail_open === 'boolean') {
        elements.issuePanel.open = restored.panel_state.issue_detail_open;
      }

      state.uiStateLoaded = true;

      if (state.selectedIssue) {
        void loadIssue(state.selectedIssue);
      }
    } catch {
      state.uiStateLoaded = true;
    }
  }

  async function loadIssue(identifier) {
    const issueId = (identifier || '').trim();
    if (!issueId) {
      return;
    }

    try {
      const payload = await fetchJson('/api/v1/' + encodeURIComponent(issueId));
      state.selectedIssue = issueId;
      elements.issueInput.value = issueId;
      const summaryParts = [];
      summaryParts.push('Status: ' + (payload.status || 'unknown'));
      if (payload.workspace && payload.workspace.path) {
        summaryParts.push('Workspace: ' + payload.workspace.path);
      }
      if (payload.retry && payload.retry.stop_reason_code) {
        summaryParts.push('Stop reason: ' + payload.retry.stop_reason_code);
      }
      if (payload.blocked && payload.blocked.stop_reason_code) {
        summaryParts.push('Blocked reason: ' + payload.blocked.stop_reason_code);
      }
      if (payload.retry && payload.retry.previous_session_id) {
        summaryParts.push('Previous session: ' + payload.retry.previous_session_id);
      }
      if (payload.blocked && payload.blocked.previous_session_id) {
        summaryParts.push('Previous session: ' + payload.blocked.previous_session_id);
      }
      if (payload.running && payload.running.current_phase) {
        summaryParts.push('Current phase: ' + payload.running.current_phase);
      }
      if ((payload.retry && payload.retry.last_phase) || (payload.blocked && payload.blocked.last_phase)) {
        summaryParts.push('Last phase before stop: ' + ((payload.retry && payload.retry.last_phase) || (payload.blocked && payload.blocked.last_phase)));
      }
      const runningOrRetry = payload.running || payload.retry || payload.blocked;
      if (runningOrRetry && runningOrRetry.provisioner_type) {
        summaryParts.push('Provisioner: ' + runningOrRetry.provisioner_type);
      }
      if (runningOrRetry && runningOrRetry.branch_name) {
        summaryParts.push('Branch: ' + runningOrRetry.branch_name);
      }
      if (runningOrRetry && runningOrRetry.workspace_git_status) {
        summaryParts.push('Workspace git: ' + runningOrRetry.workspace_git_status);
      }
      if (runningOrRetry && typeof runningOrRetry.workspace_provisioned === 'boolean') {
        summaryParts.push('Provisioned: ' + (runningOrRetry.workspace_provisioned ? 'yes' : 'no'));
      }
      if (runningOrRetry && typeof runningOrRetry.workspace_is_git_worktree === 'boolean') {
        summaryParts.push('Git worktree: ' + (runningOrRetry.workspace_is_git_worktree ? 'yes' : 'no'));
      }
      if (state.runtimeResolution && state.runtimeResolution.workspace_root) {
        summaryParts.push('Runtime workspace root: ' + state.runtimeResolution.workspace_root);
      }
      elements.issueSummary.textContent = summaryParts.join(' • ');
      const timeline = Array.isArray(payload.phase_timeline) ? payload.phase_timeline : [];
      const timelineText = timeline.length
        ? timeline.map(function (marker) {
            return marker.at + ' | ' + marker.phase + ' | attempt ' + marker.attempt + ' | ' + (marker.detail || 'n/a') + ' | thread ' + (marker.thread_id || 'n/a') + ' | session ' + (marker.session_id || 'n/a');
          }).join('\\n')
        : 'No phase markers yet.';
      elements.issueOutput.textContent = 'Execution Timeline\\n' + timelineText + '\\n\\nIssue JSON\\n' + JSON.stringify(payload, null, 2);
      if (state.payload) {
        renderRunning(state.payload);
      }
      scheduleStateSave();
    } catch (error) {
      elements.issueSummary.textContent = 'Issue load failed.';
      elements.issueOutput.textContent = 'Issue load failed: ' + String(error);
    }
  }

  async function resumeBlockedIssue(issueIdentifier) {
    try {
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueIdentifier) + '/resume', {
        method: 'POST'
      });
      setRefreshStatus('Resume requested for ' + payload.issue_identifier, false);
      await loadStateViaPoll();
      if (state.selectedIssue === issueIdentifier) {
        await loadIssue(issueIdentifier);
      }
    } catch (error) {
      setRefreshStatus('Resume failed: ' + String(error), true);
    }
  }

  async function refreshNow() {
    try {
      const payload = await fetchJson('/api/v1/refresh', { method: 'POST' });
      setRefreshStatus(payload.coalesced ? 'Refresh request coalesced' : 'Refresh queued', false);
      await loadStateViaPoll();
    } catch (error) {
      setRefreshStatus('Refresh failed: ' + String(error), true);
    }
  }

  async function loadDiagnostics() {
    try {
      const diagnostics = await fetchJson('/api/v1/diagnostics');
      state.runtimeResolution = diagnostics.runtime_resolution || null;
      elements.diagnosticsOutput.textContent = JSON.stringify(diagnostics, null, 2);
      renderRuntimeResolution(state.runtimeResolution);
    } catch {
      elements.diagnosticsOutput.textContent = 'Diagnostics unavailable.';
      state.runtimeResolution = null;
      renderRuntimeResolution(null);
    }

    try {
      const historyPayload = await fetchJson('/api/v1/history?limit=8');
      const runs = Array.isArray(historyPayload.runs) ? historyPayload.runs : [];
      if (!runs.length) {
        const empty = document.createElement('li');
        empty.className = 'muted';
        empty.textContent = 'No run history available.';
        elements.historyList.replaceChildren(empty);
        return;
      }

      const nodes = runs.map((entry) => {
        const item = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = entry.issue_identifier + ' (' + (entry.terminal_status || 'active') + ')';
        const meta = document.createElement('span');
        meta.textContent = ' • started ' + formatDate(entry.started_at) + (entry.ended_at ? ' • ended ' + formatDate(entry.ended_at) : '');
        item.append(title, meta);
        return item;
      });
      elements.historyList.replaceChildren(...nodes);
    } catch {
      const empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'History unavailable.';
      elements.historyList.replaceChildren(empty);
    }
  }

  function handleSseEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object') {
      return;
    }

    const type = envelope.type;
    const payload = envelope.payload;

    if (type === 'state_snapshot' && payload && payload.state) {
      applyPayload(payload.state, 'stream');
      return;
    }

    if (type === 'refresh_accepted' && payload && payload.accepted) {
      setRefreshStatus(payload.accepted.coalesced ? 'Refresh request coalesced' : 'Refresh queued', false);
      return;
    }

    if (type === 'runtime_health_changed' && payload && payload.health) {
      const dispatch = payload.health.dispatch_validation || 'unknown';
      const message = payload.health.last_error ? payload.health.last_error : 'health changed';
      setRefreshStatus('Health changed: ' + dispatch + ' (' + message + ')', dispatch === 'failed');
      return;
    }
  }

  function connectStream() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }

    const stream = new EventSource('/api/v1/events');
    state.eventSource = stream;

    stream.onopen = function () {
      state.streamConnected = true;
      state.streamRetryMs = 1000;
      setConnectionStatus('live', 'Streaming updates connected');
    };

    stream.onmessage = function (event) {
      try {
        const envelope = JSON.parse(event.data);
        handleSseEnvelope(envelope);
      } catch {
        // Ignore malformed envelopes.
      }
    };

    stream.onerror = function () {
      state.streamConnected = false;
      setConnectionStatus('offline', 'Stream disconnected; retrying with polling fallback');
      stream.close();
      state.eventSource = null;
      setTimeout(connectStream, state.streamRetryMs);
      state.streamRetryMs = Math.min(state.streamRetryMs * 2, 15000);
    };
  }

  function wireEvents() {
    elements.refreshButton.addEventListener('click', function () {
      void refreshNow();
    });

    elements.issueLoad.addEventListener('click', function () {
      void loadIssue(elements.issueInput.value);
    });

    elements.issueInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        void loadIssue(elements.issueInput.value);
      }
    });

    elements.issueOpenJson.addEventListener('click', function () {
      const identifier = (elements.issueInput.value || state.selectedIssue || '').trim();
      if (!identifier) {
        setRefreshStatus('Provide an issue identifier first', true);
        return;
      }
      window.open('/api/v1/' + encodeURIComponent(identifier), '_blank', 'noopener');
    });

    elements.runningFilter.addEventListener('input', function (event) {
      state.filter.query = event.target && event.target.value ? event.target.value : '';
      if (state.payload) {
        renderRunning(state.payload);
        renderRetry(state.payload);
        renderBlocked(state.payload);
      }
      scheduleStateSave();
    });

    elements.statusFilter.addEventListener('change', function (event) {
      state.filter.status = event.target && event.target.value ? event.target.value : 'all';
      if (state.payload) {
        renderRunning(state.payload);
        renderRetry(state.payload);
        renderBlocked(state.payload);
      }
      scheduleStateSave();
    });

    elements.eventFeedFilter.addEventListener('change', function (event) {
      state.filter.eventFeedSeverity = event.target && event.target.value ? event.target.value : 'all';
      if (state.payload) {
        renderRuntimeEvents(state.payload);
      }
      scheduleStateSave();
    });

    elements.issuePanel.addEventListener('toggle', function () {
      scheduleStateSave();
    });

    elements.throughputPanel.addEventListener('toggle', function () {
      state.panels.throughputOpen = !!elements.throughputPanel.open;
      scheduleStateSave();
    });

    elements.runtimeEventsPanel.addEventListener('toggle', function () {
      state.panels.runtimeEventsOpen = !!elements.runtimeEventsPanel.open;
      scheduleStateSave();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === '/' && document.activeElement !== elements.runningFilter) {
        event.preventDefault();
        elements.runningFilter.focus();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        void refreshNow();
      }
    });
  }

  wireEvents();
  void loadUiState();
  void loadDiagnostics();
  if (DASHBOARD_CONFIG.dashboard_enabled) {
    void loadStateViaPoll();
    connectStream();
    state.runtimeTicker = setInterval(updateRuntimeClock, DASHBOARD_CONFIG.render_interval_ms);
  } else {
    setConnectionStatus('offline', 'Dashboard refresh disabled by configuration');
    void loadStateViaPoll();
  }
})();`;
}

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

.badge-offline {
  background: var(--warn-soft);
  color: var(--warn);
}

.hero-actions {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
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

.mini-badge-bad {
  background: #f8e8e8;
  color: #8a2f2f;
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
