import {
  ACTION_REQUIRED_REASON_LABELS
} from './dashboard-view-model';
import { REASON_CODES } from '../observability/reason-codes';

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

  <section id="action-required-banner" class="action-required-banner hidden" role="region" aria-live="polite">
    <strong id="action-required-title">Action Required</strong>
    <span id="action-required-summary"></span>
    <div id="action-required-groups" class="inline-badges"></div>
  </section>

  <section id="api-degraded-banner" class="api-degraded-banner hidden" role="region" aria-live="polite">
    <strong>API Degraded</strong>
    <span id="api-degraded-summary"></span>
  </section>

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
              <th>Blocker</th>
              <th>Time Since Progress</th>
              <th>Last Successful Step</th>
              <th>Last Event</th>
              <th>Last Message</th>
              <th>Last Event At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="running-rows">
            <tr><td colspan="14" class="muted">No running issues.</td></tr>
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
      <div class="panel-head">
        <h2>Stopped Run Recovery</h2>
        <button id="stopped-run-recovery-load" type="button">Load Recovery</button>
      </div>
      <p class="muted">Use these cards when a run has already stopped and no longer appears in running, retrying, or blocked state. Inspect forensics first, then resume only when the API marks resume valid.</p>
      <div id="stopped-run-recovery-list" class="recovery-list">
        <p class="muted">No recent stopped runs need recovery.</p>
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
          <div id="issue-explainer-card" class="operator-explainer hidden" aria-live="polite">
            <div class="operator-explainer-head">
              <span id="issue-explainer-actionability" class="status-pill">none</span>
              <strong id="issue-explainer-headline">No diagnostics loaded</strong>
            </div>
            <dl class="operator-explainer-grid">
              <div>
                <dt>Classification</dt>
                <dd id="issue-explainer-classification">n/a</dd>
              </div>
              <div>
                <dt>Reason</dt>
                <dd id="issue-explainer-reason">n/a</dd>
              </div>
              <div>
                <dt>Recommended Action</dt>
                <dd id="issue-explainer-action">n/a</dd>
              </div>
              <div>
                <dt>Expected Transition</dt>
                <dd id="issue-explainer-transition">n/a</dd>
              </div>
              <div>
                <dt>Map Version</dt>
                <dd id="issue-explainer-version">n/a</dd>
              </div>
            </dl>
            <p id="issue-explainer-detail" class="muted"></p>
          </div>
          <div id="thread-detail" class="thread-detail hidden" aria-live="polite">
            <div class="thread-detail-grid">
              <section class="thread-detail-section">
                <h3>Timeline Lanes</h3>
                <div id="thread-timeline-lanes" class="timeline-lanes"></div>
              </section>
              <section class="thread-detail-section">
                <h3>Blocker Intelligence</h3>
                <dl id="thread-blocker-card" class="blocker-card"></dl>
              </section>
              <section class="thread-detail-section">
                <h3>Capability Warnings</h3>
                <div id="thread-capability-warnings" class="capability-warnings muted">No capability warnings.</div>
              </section>
            </div>
            <section class="thread-detail-section">
              <h3>Raw Event Stream</h3>
              <pre id="thread-raw-events" class="code-block raw-event-stream">No thread diagnostics loaded.</pre>
            </section>
          </div>
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
  const actionRequiredReasonLabels = JSON.stringify(ACTION_REQUIRED_REASON_LABELS);
  const operatorTransitionRules = JSON.stringify({
    detailMap: {
      'completion gate blocked redispatch because no progress signal was detected': 'completion_gate_blocked',
      'pr is open but scope is incomplete and no progress signal was detected': 'completion_gate_blocked',
      'respawn circuit breaker opened': 'circuit_breaker_opened',
      'resume accepted': 'resume_accepted',
      'resume rejected': 'resume_rejected',
      'cancel accepted': 'cancel_accepted',
      'cancel rejected': 'cancel_rejected'
    },
    eventMap: {
      'orchestrator.redispatch.completion_gate_blocked': 'completion_gate_blocked',
      'orchestrator.redispatch.circuit_breaker_opened': 'circuit_breaker_opened',
      'orchestration.blocked_input.resumed': 'resume_accepted'
    }
  });
  return `(() => {
  const DASHBOARD_CONFIG = ${JSON.stringify(safeConfig)};
  const ACTION_REQUIRED_CODES = ${actionRequiredReasonLabels};
  const OPERATOR_TRANSITION_RULES = ${operatorTransitionRules};
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
    stoppedRunRecoveryLoaded: false,
    stoppedRunRecoveryLoading: false,
    stoppedRunRecoveryPayload: null,
    filter: {
      query: '',
      status: 'all',
      eventFeedSeverity: 'all',
      blockedReason: 'all'
    },
    panels: {
      throughputOpen: true,
      runtimeEventsOpen: true
    },
    suppressIssuePanelToggleLoad: false,
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
    actionRequiredBanner: document.getElementById('action-required-banner'),
    actionRequiredTitle: document.getElementById('action-required-title'),
    actionRequiredSummary: document.getElementById('action-required-summary'),
    actionRequiredGroups: document.getElementById('action-required-groups'),
    apiDegradedBanner: document.getElementById('api-degraded-banner'),
    apiDegradedSummary: document.getElementById('api-degraded-summary'),
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
    stoppedRunRecoveryList: document.getElementById('stopped-run-recovery-list'),
    stoppedRunRecoveryLoad: document.getElementById('stopped-run-recovery-load'),
    statusFilter: document.getElementById('status-filter'),
    runningFilter: document.getElementById('running-filter'),
    issuePanel: document.getElementById('issue-panel'),
    issueInput: document.getElementById('issue-input'),
    issueLoad: document.getElementById('issue-load'),
    issueOpenJson: document.getElementById('issue-open-json'),
    issueSummary: document.getElementById('issue-summary'),
    issueExplainerCard: document.getElementById('issue-explainer-card'),
    issueExplainerActionability: document.getElementById('issue-explainer-actionability'),
    issueExplainerHeadline: document.getElementById('issue-explainer-headline'),
    issueExplainerClassification: document.getElementById('issue-explainer-classification'),
    issueExplainerReason: document.getElementById('issue-explainer-reason'),
    issueExplainerAction: document.getElementById('issue-explainer-action'),
    issueExplainerTransition: document.getElementById('issue-explainer-transition'),
    issueExplainerVersion: document.getElementById('issue-explainer-version'),
    issueExplainerDetail: document.getElementById('issue-explainer-detail'),
    threadDetail: document.getElementById('thread-detail'),
    threadTimelineLanes: document.getElementById('thread-timeline-lanes'),
    threadBlockerCard: document.getElementById('thread-blocker-card'),
    threadCapabilityWarnings: document.getElementById('thread-capability-warnings'),
    threadRawEvents: document.getElementById('thread-raw-events'),
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
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value).toLocaleString();
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

  function formatDurationFromEpochMs(epochMs) {
    if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
      return 'n/a';
    }
    return formatDurationFromMs(epochMs);
  }

  function getTurnControlLabel(state) {
    switch (state) {
      case 'agent_turn':
        return 'Agent Turn';
      case 'operator_turn':
        return 'Operator Turn';
      case 'blocked_manual_resume':
        return 'Manual Resume Required';
      default:
        return 'Turn Unknown';
    }
  }

  function getProgressSignalLabel(state) {
    switch (state) {
      case 'advancing':
        return 'Advancing';
      case 'heartbeat_only':
        return 'Heartbeat Only';
      case 'stalled_waiting':
        return 'Stalled Waiting';
      default:
        return 'Progress Unknown';
    }
  }

  function getTokenConfidenceLabel(confidence) {
    switch (confidence) {
      case 'observed_live':
        return 'Live';
      case 'backfilled':
        return 'Backfilled';
      case 'missing':
        return 'Missing';
      default:
        return 'Unknown';
    }
  }
  function formatDurationFromMs(timestampMs) {
    if (!Number.isFinite(timestampMs)) {
      return 'n/a';
    }
    const seconds = Math.max(0, Math.floor((Date.now() - Number(timestampMs)) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remain = seconds % 60;
    return minutes + 'm ' + remain + 's';
  }

  function formatElapsedMs(durationMs) {
    if (!Number.isFinite(durationMs)) {
      return 'n/a';
    }
    const seconds = Math.max(0, Math.floor(Number(durationMs) / 1000));
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
    const generatedAtMs = state.payload && typeof state.payload.snapshot_generated_at_ms === 'number'
      ? state.payload.snapshot_generated_at_ms
      : Date.parse(value || '');
    const ageText = Number.isFinite(generatedAtMs) ? ' • age ' + formatDurationFromEpochMs(generatedAtMs) : '';
    const freshness = state.payload && state.payload.snapshot_freshness_state ? ' • ' + state.payload.snapshot_freshness_state : '';
    elements.lastUpdated.textContent = 'Last update: ' + formatDate(value) + ageText + freshness;
  }

  function setRefreshStatus(message, isError) {
    elements.refreshStatus.textContent = message;
    elements.refreshStatus.className = isError ? 'status-error' : 'status-ok';
  }

  function getActionRequiredLabel(code) {
    return ACTION_REQUIRED_CODES[code] || code || 'unknown';
  }

  function createBlockedRootCauseBlock(entry) {
    if (!entry || !entry.root_cause) {
      return null;
    }
    const block = document.createElement('div');
    block.className = 'root-cause-block';
    const label = document.createElement('div');
    label.className = 'root-cause-label';
    label.textContent = 'Root cause';
    const summary = document.createElement('div');
    summary.className = 'root-cause-summary';
    const rootCauseSummary =
      entry.root_cause.reason_code === 'worktree_dirty_repo'
        ? 'Workspace provisioning failed: repo root has uncommitted or untracked files.'
        : entry.root_cause.summary || entry.root_cause.detail || entry.root_cause.reason_code || 'n/a';
    summary.textContent = rootCauseSummary;
    block.append(label, summary);
    if (entry.root_cause.detail) {
      const detail = document.createElement('div');
      detail.className = 'muted';
      detail.textContent = 'Failed phase detail: ' + entry.root_cause.detail;
      block.append(detail);
    }
    const remediationHint =
      entry.root_cause.remediation_hint ||
      (entry.root_cause.reason_code === 'worktree_dirty_repo'
        ? 'Clean, commit, or ignore the dirty repo files, then requeue or resume.'
        : null);
    if (remediationHint) {
      const remediation = document.createElement('div');
      remediation.className = 'status-pill pending';
      remediation.textContent = 'Remediation: ' + remediationHint;
      block.append(remediation);
    }
    return block;
  }

  function isActionRequiredCode(code) {
    return Boolean(code && ACTION_REQUIRED_CODES[code]);
  }

  function formatBudgetStatusLabel(status) {
    switch (status) {
      case 'warning':
        return 'Warning';
      case 'hard_limited':
        return 'Hard limited';
      case 'telemetry_unavailable':
        return 'Telemetry unavailable';
      case 'ok':
        return 'Ok';
      default:
        return 'Not configured';
    }
  }

  function budgetStatusClass(status) {
    if (status === 'hard_limited') {
      return 'failed';
    }
    if (status === 'warning' || status === 'telemetry_unavailable') {
      return 'pending';
    }
    return 'success';
  }

  function createBudgetBlock(entry) {
    const container = document.createElement('div');
    container.className = 'budget-summary';
    const status = entry && entry.budget_status ? entry.budget_status : null;
    const statusPill = document.createElement('div');
    statusPill.className = 'status-pill ' + budgetStatusClass(status);
    statusPill.textContent = 'Budget: ' + formatBudgetStatusLabel(status);
    container.append(statusPill);

    const detail = document.createElement('div');
    detail.className = 'muted';
    if (status === 'telemetry_unavailable') {
      detail.textContent = 'Budget usage unavailable; not counted as zero.';
    } else if (typeof entry.budget_usage_tokens === 'number' || typeof entry.budget_limit_tokens === 'number') {
      const usage = typeof entry.budget_usage_tokens === 'number' ? formatNumber(entry.budget_usage_tokens) : 'n/a';
      const limit = typeof entry.budget_limit_tokens === 'number' ? formatNumber(entry.budget_limit_tokens) : 'n/a';
      detail.textContent = usage + ' / ' + limit + ' tokens';
    } else {
      detail.textContent = 'No token budget configured.';
    }
    container.append(detail);

    const metaParts = [];
    if (typeof entry.budget_window_minutes === 'number') {
      metaParts.push('Window ' + formatNumber(entry.budget_window_minutes) + 'm');
    }
    if (entry.budget_policy) {
      metaParts.push('Policy ' + entry.budget_policy);
    }
    if (metaParts.length) {
      const meta = document.createElement('div');
      meta.className = 'muted';
      meta.textContent = metaParts.join(' • ');
      container.append(meta);
    }
    if (entry.budget_message) {
      const message = document.createElement('div');
      message.className = status === 'hard_limited' ? 'status-error' : 'muted';
      message.textContent = 'Budget stopped continuation: ' + entry.budget_message;
      container.append(message);
    }
    return container;
  }

  function formatBudgetSummary(entry) {
    const status = entry && entry.budget_status ? entry.budget_status : null;
    const parts = ['Budget: ' + formatBudgetStatusLabel(status)];
    if (status === 'telemetry_unavailable') {
      parts.push('usage unavailable');
    } else if (entry && (typeof entry.budget_usage_tokens === 'number' || typeof entry.budget_limit_tokens === 'number')) {
      const usage = typeof entry.budget_usage_tokens === 'number' ? formatNumber(entry.budget_usage_tokens) : 'n/a';
      const limit = typeof entry.budget_limit_tokens === 'number' ? formatNumber(entry.budget_limit_tokens) : 'n/a';
      parts.push(usage + ' / ' + limit + ' tokens');
    }
    if (entry && typeof entry.budget_window_minutes === 'number') {
      parts.push('window ' + formatNumber(entry.budget_window_minutes) + 'm');
    }
    if (entry && entry.budget_policy) {
      parts.push('policy ' + entry.budget_policy);
    }
    if (entry && entry.budget_message) {
      parts.push(entry.budget_message);
    }
    return parts.join(' • ');
  }

  function formatApiError(payload, fallbackMessage) {
    if (!payload || !payload.error) {
      return fallbackMessage;
    }
    if (payload.error.code && payload.error.message) {
      return payload.error.code + ': ' + payload.error.message;
    }
    if (payload.error.message) {
      return String(payload.error.message);
    }
    return fallbackMessage;
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
      createMetricCard('Stopped', formatNumber(payload.counts.stopped || 0)),
      createMetricCard('Stalled Waiting', formatNumber(payload.counts.running_stalled_waiting_count || 0)),
      createMetricCard('Awaiting Input', formatNumber(payload.counts.running_awaiting_input_count || 0)),
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

  function renderActionRequiredBanner(payload) {
    const blockedEntries = Array.isArray(payload && payload.blocked) ? payload.blocked : [];
    const grouped = blockedEntries.reduce(function (acc, entry) {
      if (!isActionRequiredCode(entry.stop_reason_code)) {
        return acc;
      }
      acc[entry.stop_reason_code] = (acc[entry.stop_reason_code] || 0) + 1;
      return acc;
    }, {});
    const groupedEntries = Object.entries(grouped);
    if (!groupedEntries.length) {
      elements.actionRequiredBanner.classList.add('hidden');
      elements.actionRequiredSummary.textContent = '';
      elements.actionRequiredGroups.replaceChildren();
      return;
    }

    const total = groupedEntries.reduce(function (sum, entry) {
      const count = entry[1];
      return sum + count;
    }, 0);
    elements.actionRequiredBanner.classList.remove('hidden');
    elements.actionRequiredSummary.textContent = total + ' blocked run' + (total === 1 ? '' : 's') + ' need operator action.';

    const groupNodes = groupedEntries.map(function (entry) {
      const code = entry[0];
      const count = entry[1];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost-button reason-chip';
      button.textContent = getActionRequiredLabel(code) + ' (' + count + ')';
      button.title = 'Filter blocked rows for ' + getActionRequiredLabel(code);
      button.addEventListener('click', function () {
        state.filter.status = 'blocked';
        state.filter.blockedReason = code;
        elements.statusFilter.value = 'blocked';
        if (state.payload) {
          renderRunning(state.payload);
          renderRetry(state.payload);
          renderBlocked(state.payload);
        }
      });
      return button;
    });
    elements.actionRequiredGroups.replaceChildren(...groupNodes);
  }

  function renderApiDegradedBanner(payload) {
    if (!payload || !payload.api_degraded_mode) {
      elements.apiDegradedBanner.classList.add('hidden');
      elements.apiDegradedSummary.textContent = '';
      return;
    }
    const routes = Array.isArray(payload.api_degraded_routes) ? payload.api_degraded_routes.join(', ') : 'n/a';
    elements.apiDegradedBanner.classList.remove('hidden');
    elements.apiDegradedSummary.textContent =
      (payload.api_degraded_reason_code || 'unknown') + ' • fallback routes: ' + routes;
  }

  function describeTransition(transition) {
    switch (transition) {
      case 'completion_gate_blocked':
        return { label: 'Completion Gate Blocked', result: 'failure', detail: 'No progress signal detected in redispatch window.' };
      case 'circuit_breaker_opened':
        return { label: 'Circuit Breaker Opened', result: 'failure', detail: 'Respawn threshold reached; operator intervention required.' };
      case 'resume_accepted':
        return { label: 'Resume Accepted', result: 'success', detail: 'Resume request accepted and redispatch restarted.' };
      case 'resume_rejected':
        return { label: 'Resume Rejected', result: 'failure', detail: 'Resume request rejected; resolve blocking condition first.' };
      case 'cancel_accepted':
        return { label: 'Cancel Accepted', result: 'success', detail: 'Issue returned to backlog.' };
      case 'cancel_rejected':
        return { label: 'Cancel Rejected', result: 'failure', detail: 'Cancel request rejected; tracker state unchanged.' };
      default:
        return null;
    }
  }

  function deriveOperatorTransitionRows(issueId, payload) {
    const rows = [];
    const seen = new Set();
    function addRow(at, transition, detail) {
      const key = transition + ':' + String(at || 'n/a') + ':' + String(detail || '');
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const descriptor = describeTransition(transition);
      if (!descriptor) {
        return;
      }
      rows.push({
        at: at || 'n/a',
        issue_identifier: issueId,
        label: descriptor.label,
        result: descriptor.result,
        detail: detail && detail.trim ? (detail.trim() ? detail : descriptor.detail) : descriptor.detail
      });
    }

    const timeline = Array.isArray(payload.phase_timeline) ? payload.phase_timeline : [];
    for (const marker of timeline) {
      const normalized = String(marker && marker.detail ? marker.detail : '').trim().toLowerCase();
      const transition = OPERATOR_TRANSITION_RULES.detailMap[normalized];
      if (transition) {
        addRow(marker.at, transition, marker.detail || null);
      }
    }
    const events = Array.isArray(payload.recent_events) ? payload.recent_events : [];
    for (const entry of events) {
      const transitionByEvent = OPERATOR_TRANSITION_RULES.eventMap[String(entry && entry.event ? entry.event : '')];
      if (transitionByEvent) {
        addRow(entry.at, transitionByEvent, entry.message || null);
      }
      const normalizedMessage = String(entry && entry.message ? entry.message : '').trim().toLowerCase();
      const transitionByMessage = OPERATOR_TRANSITION_RULES.detailMap[normalizedMessage];
      if (transitionByMessage) {
        addRow(entry.at, transitionByMessage, entry.message || null);
      }
    }
    if (payload.blocked && (payload.blocked.stop_reason_code === '${REASON_CODES.operatorNoProgressRedispatchBlocked}' || payload.blocked.stop_reason_code === '${REASON_CODES.awaitingHumanReviewScopeIncomplete}')) {
      addRow('n/a', 'completion_gate_blocked', payload.blocked.stop_reason_detail || null);
    }
    return rows.sort(function (a, b) {
      const atA = Date.parse(a.at);
      const atB = Date.parse(b.at);
      if (Number.isFinite(atA) && Number.isFinite(atB)) {
        return atA - atB;
      }
      if (Number.isFinite(atA)) {
        return -1;
      }
      if (Number.isFinite(atB)) {
        return 1;
      }
      return a.label.localeCompare(b.label);
    });
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
      const emptyStopped = document.createElement('p');
      emptyStopped.className = 'muted';
      emptyStopped.textContent = 'No stopped-run recovery data while snapshot is unavailable.';
      elements.stoppedRunRecoveryList.replaceChildren(emptyStopped);
      return;
    }

    // Keep stale-but-last-known-good data visible while snapshot fetch is degraded.
    renderOverview(state.lastGoodPayload);
    renderThroughput(state.lastGoodPayload);
    renderRunning(state.lastGoodPayload);
    renderRetry(state.lastGoodPayload);
    renderBlocked(state.lastGoodPayload);
    renderStoppedRunRecovery(state.lastGoodPayload);
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

  function normalizeActionability(value) {
    const actionability = String(value || 'none');
    return actionability === 'required' || actionability === 'recommended' ? actionability : 'none';
  }

  function createOperatorHintBadge(hint) {
    if (!hint) {
      return null;
    }
    const actionability = normalizeActionability(hint.actionability);
    const badge = document.createElement('span');
    badge.className = 'operator-hint actionability-' + actionability;
    badge.textContent = String(hint.headline || hint.classification || 'Runtime diagnostics');
    badge.title = 'Actionability: ' + actionability + ' • Classification: ' + String(hint.classification || 'unknown');
    return badge;
  }

  function renderIssueExplainer(explainer) {
    if (!explainer) {
      elements.issueExplainerCard.classList.add('hidden');
      return;
    }
    const actionability = normalizeActionability(explainer.actionability);
    elements.issueExplainerCard.className = 'operator-explainer actionability-' + actionability;
    elements.issueExplainerActionability.className = 'status-pill actionability-' + actionability;
    elements.issueExplainerActionability.textContent = actionability;
    elements.issueExplainerHeadline.textContent = explainer.headline || 'Runtime diagnostics unavailable';
    elements.issueExplainerClassification.textContent = explainer.classification || 'unknown';
    elements.issueExplainerReason.textContent =
      (explainer.reason_code || 'n/a') + (explainer.reason_detail ? ' • ' + explainer.reason_detail : '');
    elements.issueExplainerAction.textContent =
      Array.isArray(explainer.recommended_actions) && explainer.recommended_actions.length
        ? explainer.recommended_actions.join('; ')
        : 'No operator action required';
    elements.issueExplainerTransition.textContent = explainer.expected_transition || 'No automatic transition expected';
    elements.issueExplainerVersion.textContent = explainer.version || 'unknown';
    elements.issueExplainerDetail.textContent = explainer.detail || '';
  }

  function appendDefinitionValue(list, label, value) {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt');
    const definition = document.createElement('dd');
    term.textContent = label;
    definition.textContent = value === null || value === undefined || value === '' ? 'n/a' : String(value);
    wrapper.append(term, definition);
    list.append(wrapper);
  }

  function renderThreadBlockerCard(blocker) {
    elements.threadBlockerCard.replaceChildren();
    if (!blocker) {
      appendDefinitionValue(elements.threadBlockerCard, 'classification', 'n/a');
      appendDefinitionValue(elements.threadBlockerCard, 'reason_code', 'n/a');
      appendDefinitionValue(elements.threadBlockerCard, 'reason_detail', 'n/a');
      appendDefinitionValue(elements.threadBlockerCard, 'time_since_progress', 'n/a');
      appendDefinitionValue(elements.threadBlockerCard, 'recommended_actions', 'No blocker actions reported.');
      appendDefinitionValue(elements.threadBlockerCard, 'expected_auto_transition', 'n/a');
      return;
    }
    appendDefinitionValue(elements.threadBlockerCard, 'classification', blocker.classification);
    appendDefinitionValue(elements.threadBlockerCard, 'reason_code', blocker.reason_code);
    appendDefinitionValue(elements.threadBlockerCard, 'reason_detail', blocker.reason_detail);
    appendDefinitionValue(elements.threadBlockerCard, 'time_since_progress', blocker.time_since_progress);
    if (blocker.missing_tool_output_recovery) {
      const recovery = blocker.missing_tool_output_recovery;
      appendDefinitionValue(elements.threadBlockerCard, 'recovery_headline', recovery.headline);
      appendDefinitionValue(elements.threadBlockerCard, 'recovery_state', recovery.status);
      appendDefinitionValue(elements.threadBlockerCard, 'recovery_next_action', recovery.next_action);
      appendDefinitionValue(elements.threadBlockerCard, 'original_tool', recovery.original_tool_name);
      appendDefinitionValue(elements.threadBlockerCard, 'original_call_id', recovery.original_call_id);
      appendDefinitionValue(elements.threadBlockerCard, 'evidence_source', recovery.evidence_source);
      appendDefinitionValue(elements.threadBlockerCard, 'elapsed_wait_ms', recovery.elapsed_wait_ms);
      appendDefinitionValue(
        elements.threadBlockerCard,
        'active_ownership',
        recovery.active_ownership
          ? [
              'issue ' + (recovery.active_ownership.issue_identifier || recovery.active_ownership.issue_id || 'n/a'),
              'thread ' + (recovery.active_ownership.thread_id || 'n/a'),
              'turn ' + (recovery.active_ownership.turn_id || 'n/a'),
              'session ' + (recovery.active_ownership.session_id || 'n/a'),
              'app_server_owned ' + String(Boolean(recovery.active_ownership.app_server_owned))
            ].join(' | ')
          : 'n/a'
      );
      appendDefinitionValue(
        elements.threadBlockerCard,
        'recovery_lineage',
        [
          'interrupt ' + ((recovery.interrupt_cancel_result && recovery.interrupt_cancel_result.status) || 'n/a'),
          'replacement_thread ' + ((recovery.replacement_turn && recovery.replacement_turn.thread_id) || 'n/a'),
          'replacement_turn ' + ((recovery.replacement_turn && recovery.replacement_turn.turn_id) || 'n/a'),
          'prompt ' + ((recovery.guarded_prompt_dispatch && recovery.guarded_prompt_dispatch.status) || 'n/a'),
          'outcome ' + ((recovery.final_outcome && recovery.final_outcome.result) || 'n/a')
        ].join(' | ')
      );
    }
    appendDefinitionValue(
      elements.threadBlockerCard,
      'recommended_actions',
      Array.isArray(blocker.recommended_actions) ? blocker.recommended_actions.join('; ') : 'n/a'
    );
    appendDefinitionValue(elements.threadBlockerCard, 'expected_auto_transition', blocker.expected_auto_transition);
  }

  function spanLabel(span, kind) {
    if (kind === 'phase') {
      return span.phase || 'phase';
    }
    if (kind === 'tool') {
      return span.tool_name || 'tool';
    }
    return span.reason_code || span.status || 'wait';
  }

  function renderTimelineLane(title, spans, kind) {
    const lane = document.createElement('section');
    lane.className = 'timeline-lane timeline-lane-' + kind;
    const heading = document.createElement('h4');
    heading.textContent = title;
    lane.append(heading);
    const safeSpans = Array.isArray(spans) ? spans : [];
    if (!safeSpans.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No ' + title.toLowerCase() + ' spans.';
      lane.append(empty);
      return lane;
    }
    const list = document.createElement('ul');
    for (const span of safeSpans) {
      const item = document.createElement('li');
      const label = document.createElement('strong');
      const meta = document.createElement('span');
      label.textContent = spanLabel(span, kind);
      meta.textContent =
        ' | started ' +
        formatDate(span.started_at_ms) +
        ' | ended ' +
        (span.ended_at_ms === null || span.ended_at_ms === undefined ? 'open' : formatDate(span.ended_at_ms)) +
        ' | duration ' +
        (span.duration_ms === null || span.duration_ms === undefined ? 'open' : String(span.duration_ms)) +
        ' | status ' +
        (span.status || 'n/a') +
        ' | reason ' +
        (span.reason_code || 'n/a') +
        ' | ' +
        (span.reason_detail || 'n/a');
      item.append(label, meta);
      list.append(item);
    }
    lane.append(list);
    return lane;
  }

  function renderThreadDiagnostics(diagnostics) {
    if (!diagnostics) {
      elements.threadDetail.classList.add('hidden');
      elements.threadRawEvents.textContent = 'Detailed diagnostics are not loaded.';
      return;
    }
    elements.threadDetail.classList.remove('hidden');
    elements.threadTimelineLanes.replaceChildren(
      renderTimelineLane('Phase', diagnostics.phase_spans, 'phase'),
      renderTimelineLane('Tool', diagnostics.tool_spans, 'tool'),
      renderTimelineLane('Wait', diagnostics.wait_spans, 'wait')
    );
    renderThreadBlockerCard(diagnostics.current_blocker || null);
    const warnings = Array.isArray(diagnostics.capability_warnings) ? diagnostics.capability_warnings : [];
    if (!warnings.length) {
      elements.threadCapabilityWarnings.className = 'capability-warnings muted';
      elements.threadCapabilityWarnings.textContent = 'No capability warnings.';
    } else {
      elements.threadCapabilityWarnings.className = 'capability-warnings';
      const list = document.createElement('ul');
      for (const warning of warnings) {
        const item = document.createElement('li');
        item.textContent =
          (warning.reason_code || 'capability_warning') +
          ' | source ' +
          (warning.source_environment || 'n/a') +
          ' | tool ' +
          (warning.attempted_tool_name || 'n/a') +
          ' | call ' +
          (warning.call_id || 'n/a') +
          ' | thread ' +
          (warning.thread_id || 'n/a') +
          ' | turn ' +
          (warning.turn_id || 'n/a') +
          ' | ' +
          (warning.unsupported_capability_message || 'unsupported capability') +
          ' | recovery ' +
          (warning.recommended_recovery_action || 'n/a');
        list.append(item);
      }
      elements.threadCapabilityWarnings.replaceChildren(list);
    }
    const events = Array.isArray(diagnostics.timeline) ? diagnostics.timeline : [];
    elements.threadRawEvents.textContent = events.length
      ? events
          .map(function (event) {
            return (
              event.at_ms +
              ' | ' +
              event.event +
              ' | thread ' +
              (event.thread_id || 'n/a') +
              ' | turn ' +
              (event.turn_id || 'n/a') +
              ' | session ' +
              (event.session_id || 'n/a') +
              ' | reason ' +
              (event.reason_code || 'n/a') +
              ' | ' +
              (event.reason_detail || 'n/a')
            );
          })
          .join('\\n')
      : 'No raw event stream entries.';
  }

  function getDiagnosticSummary(entry) {
    return entry && entry.transcript_tool_call_diagnostic_summary ? entry.transcript_tool_call_diagnostic_summary : null;
  }

  function formatDiagnosticSummary(summary) {
    if (!summary) {
      return 'Summary diagnostics: unavailable';
    }
    const parts = [];
    parts.push(summary.detailed_diagnostics_available ? 'detail available' : 'summary only');
    parts.push(formatNumber(summary.total_count || 0) + ' transcript records');
    if (summary.active_missing_tool_output && summary.active_missing_tool_output.active) {
      parts.push('missing output ' + (summary.active_missing_tool_output.tool_name || summary.active_missing_tool_output.call_id || 'active'));
    }
    if (summary.recovery && summary.recovery.active) {
      parts.push('recovery ' + (summary.recovery.status || 'active'));
    }
    if (summary.newest_observed_at) {
      parts.push('newest ' + formatDate(summary.newest_observed_at));
    }
    return 'Summary diagnostics: ' + parts.join(' | ');
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
      cell.colSpan = 14;
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
      const issueLink = document.createElement('a');
      issueLink.href = '#thread-detail-' + encodeURIComponent(entry.issue_identifier);
      issueLink.textContent = entry.issue_identifier;
      issueLink.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        elements.issueInput.value = entry.issue_identifier;
        void loadIssue(entry.issue_identifier);
      });
      issueCell.append(issueLink);

      const stateCell = document.createElement('td');
      stateCell.appendChild(createStateBadge(entry.state));
      const stateFlags = document.createElement('div');
      stateFlags.className = 'inline-badges';
      const turnBadge = document.createElement('span');
      turnBadge.className = 'status-pill ' + (entry.turn_control_state === 'operator_turn' ? 'failed' : 'pending');
      turnBadge.textContent = getTurnControlLabel(entry.turn_control_state);
      stateFlags.append(turnBadge);
      const progressBadge = document.createElement('span');
      progressBadge.className = 'status-pill ' + (entry.progress_signal_state === 'stalled_waiting' ? 'failed' : 'pending');
      progressBadge.textContent = getProgressSignalLabel(entry.progress_signal_state);
      stateFlags.append(progressBadge);
      if (entry.awaiting_input) {
        const awaitingBadge = document.createElement('span');
        awaitingBadge.className = 'status-pill pending';
        awaitingBadge.textContent = 'Awaiting Input';
        stateFlags.append(awaitingBadge);
      }
      if (entry.stalled_waiting && entry.progress_signal_state !== 'stalled_waiting') {
        const stalledBadge = document.createElement('span');
        stalledBadge.className = 'status-pill failed';
        stalledBadge.textContent = 'Stalled Waiting';
        stateFlags.append(stalledBadge);
      }
      const runningHintBadge = createOperatorHintBadge(entry.operator_explainer_hint);
      if (runningHintBadge && entry.operator_explainer_hint.actionability !== 'none') {
        stateFlags.append(runningHintBadge);
      }
      if (stateFlags.childNodes.length > 0) {
        stateCell.append(stateFlags);
      }

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
      if (entry.awaiting_input_since_ms) {
        const awaitingTimer = document.createElement('div');
        awaitingTimer.className = 'muted';
        awaitingTimer.textContent = 'Awaiting input: ' + formatDurationFromMs(entry.awaiting_input_since_ms);
        runtimeCell.append(awaitingTimer);
      }
      if (entry.stalled_waiting_since_ms) {
        const stalledTimer = document.createElement('div');
        stalledTimer.className = 'muted';
        stalledTimer.textContent = 'Stalled waiting: ' + formatDurationFromMs(entry.stalled_waiting_since_ms);
        runtimeCell.append(stalledTimer);
      }
      if (entry.not_blocked_explainer_text) {
        const explainer = document.createElement('div');
        explainer.className = 'muted';
        explainer.textContent = 'Why not blocked: ' + entry.not_blocked_explainer_text;
        runtimeCell.append(explainer);
      }

      const turnsCell = document.createElement('td');
      turnsCell.textContent = formatNumber(entry.turn_count);

      const tokensCell = document.createElement('td');
      const tokenTotal = document.createElement('div');
      const telemetryStatus = entry.token_telemetry_status || 'unavailable';
      const telemetryConfidence = entry.token_telemetry_confidence || (telemetryStatus === 'available' ? 'observed_live' : 'missing');
      if (telemetryStatus === 'pending') {
        tokenTotal.textContent = 'Pending';
      } else if (telemetryConfidence === 'missing') {
        tokenTotal.textContent = 'Missing telemetry';
      } else {
        tokenTotal.textContent = 'Total: ' + formatNumber(entry.tokens.total_tokens);
      }
      const tokenDetail = document.createElement('div');
      tokenDetail.className = 'muted';
      if (telemetryStatus === 'available') {
        tokenDetail.textContent =
          'In ' +
          formatNumber(entry.tokens.input_tokens) +
          ' / Out ' +
          formatNumber(entry.tokens.output_tokens) +
          (entry.token_telemetry_source ? ' • ' + entry.token_telemetry_source : '');
      } else {
        tokenDetail.textContent = telemetryStatus === 'pending' ? 'Waiting for first usage payload' : 'No telemetry path detected';
      }
      const tokenBadge = document.createElement('span');
      tokenBadge.className = 'mini-badge ' + (telemetryConfidence === 'missing' ? 'mini-badge-bad' : 'mini-badge-good');
      tokenBadge.title = 'Token telemetry confidence/source quality';
      tokenBadge.textContent = getTokenConfidenceLabel(telemetryConfidence);
      tokensCell.append(tokenTotal, tokenBadge, tokenDetail);
      tokensCell.append(createBudgetBlock(entry));

      const blockerCell = document.createElement('td');
      const blockerValue = document.createElement('div');
      blockerValue.textContent = entry.current_blocker_class || 'n/a';
      const diagnosticSummary = document.createElement('div');
      diagnosticSummary.className = 'muted';
      diagnosticSummary.textContent = formatDiagnosticSummary(getDiagnosticSummary(entry));
      blockerCell.append(blockerValue, diagnosticSummary);

      const timeSinceProgressCell = document.createElement('td');
      timeSinceProgressCell.textContent =
        typeof entry.time_since_progress === 'number'
          ? String(entry.time_since_progress) + ' ms (' + formatElapsedMs(entry.time_since_progress) + ')'
          : 'n/a';

      const lastSuccessfulStepCell = document.createElement('td');
      lastSuccessfulStepCell.textContent = entry.last_successful_step || 'n/a';

      const eventCell = document.createElement('td');
      eventCell.textContent = entry.last_event_summary || entry.last_event || 'n/a';

      const messageCell = document.createElement('td');
      messageCell.textContent = entry.last_message || 'n/a';

      const lastEventAtCell = document.createElement('td');
      lastEventAtCell.textContent = formatDate(entry.last_event_at);

      const actionsCell = document.createElement('td');
      actionsCell.className = 'action-cell';
      const lastAction = Array.isArray(entry.operator_actions) && entry.operator_actions.length
        ? entry.operator_actions[entry.operator_actions.length - 1]
        : null;
      if (lastAction) {
        const actionOutcome = document.createElement('div');
        actionOutcome.className = 'muted';
        actionOutcome.textContent = 'Last action: ' + lastAction.action + ' ' + lastAction.result + (lastAction.result_code ? ' (' + lastAction.result_code + ')' : '');
        actionsCell.append(actionOutcome);
      }
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
      const respondNow = createActionButton('Respond Now', 'ghost-button', function () {
        elements.issueInput.value = entry.issue_identifier;
        void loadIssue(entry.issue_identifier);
      });
      respondNow.disabled = !entry.awaiting_input;
      const investigate = createActionButton('Investigate', 'ghost-button', function () {
        elements.issueInput.value = entry.issue_identifier;
        void loadIssue(entry.issue_identifier);
      });
      investigate.disabled = !entry.stalled_waiting;
      const cancelTurn = createActionButton('Cancel Turn', 'ghost-button', function () {
        void runOperatorAction(entry.issue_identifier, 'cancel-turn', true);
      });
      const requeue = createActionButton('Requeue', 'ghost-button', function () {
        void runOperatorAction(entry.issue_identifier, 'requeue', true);
      });
      actionsCell.append(copySession, copyThreadTurn, respondNow, investigate, cancelTurn, requeue, openJson);

      row.append(
        issueCell,
        stateCell,
        sessionCell,
        phaseCell,
        runtimeCell,
        turnsCell,
        tokensCell,
        blockerCell,
        timeSinceProgressCell,
        lastSuccessfulStepCell,
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
      stopReasonCell.append(createBudgetBlock(entry));
      const retryHintBadge = createOperatorHintBadge(entry.operator_explainer_hint);
      if (retryHintBadge) {
        stopReasonCell.append(retryHintBadge);
      }
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
      if (entry.last_input_submit) {
        const submitModeLine = document.createElement('div');
        submitModeLine.className = 'muted';
        submitModeLine.textContent =
          'Last submit: ' +
          entry.last_input_submit.resume_mode +
          ' (' +
          entry.last_input_submit.resume_reason_code +
          ') @ ' +
          formatDate(entry.last_input_submit.submitted_at);
        stopReasonCell.append(submitModeLine);
        if (entry.last_input_submit.resume_mode === 'fallback') {
          const fallbackBanner = document.createElement('div');
          fallbackBanner.className = 'status-pill pending';
          fallbackBanner.textContent = 'Native continuation unavailable; resumed via prompt context fallback.';
          stopReasonCell.append(fallbackBanner);
        }
      }
      if (entry.pending_input) {
        const pending = entry.pending_input;
        const requestLine = document.createElement('div');
        requestLine.className = 'muted';
        requestLine.textContent = 'Request: ' + (pending.request_id || 'n/a') + ' (' + (pending.input_schema_type || 'unknown') + ')';
        stopReasonCell.append(requestLine);
        if (pending.prompt_text) {
          const promptLine = document.createElement('div');
          promptLine.textContent = pending.prompt_text;
          stopReasonCell.append(promptLine);
        }
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
      const retryStep = createActionButton('Retry Step', 'ghost-button', function () {
        void runOperatorAction(entry.issue_identifier, 'retry-step', false);
      });
      const requeue = createActionButton('Requeue', 'ghost-button', function () {
        void runOperatorAction(entry.issue_identifier, 'requeue', false);
      });
      actionsCell.append(copyPreviousSession, copyPreviousThread, retryStep, requeue, openJson);

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
      if (state.filter.blockedReason !== 'all' && entry.stop_reason_code !== state.filter.blockedReason) {
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
      const rootCauseBlock = createBlockedRootCauseBlock(entry);
      if (rootCauseBlock) {
        stopReasonCell.append(rootCauseBlock);
      }
      const stopReasonCode = document.createElement('div');
      stopReasonCode.textContent =
        rootCauseBlock
          ? 'Current operator block: ' + (entry.current_operator_block?.reason_code || entry.stop_reason_code || 'n/a')
          : entry.stop_reason_code || 'n/a';
      const stopReasonDetail = document.createElement('div');
      stopReasonDetail.className = 'muted';
      stopReasonDetail.textContent =
        rootCauseBlock
          ? 'Current block detail: ' + (entry.current_operator_block?.detail || entry.stop_reason_detail || 'n/a')
          : entry.stop_reason_detail || 'n/a';
      stopReasonCell.append(stopReasonCode, stopReasonDetail);
      stopReasonCell.append(createBudgetBlock(entry));
      if (entry.stop_reason_code) {
        const stateLabel = document.createElement('div');
        stateLabel.className = 'status-pill failed';
        stateLabel.textContent = getActionRequiredLabel(entry.stop_reason_code);
        stopReasonCell.append(stateLabel);
      }
      const controlLine = document.createElement('div');
      controlLine.className = 'inline-badges';
      const turnBadge = document.createElement('span');
      turnBadge.className = 'status-pill failed';
      turnBadge.textContent = getTurnControlLabel(entry.turn_control_state);
      const progressBadge = document.createElement('span');
      progressBadge.className = 'status-pill failed';
      progressBadge.textContent = getProgressSignalLabel(entry.progress_signal_state);
      controlLine.append(turnBadge, progressBadge);
      stopReasonCell.append(controlLine);
      const blockedHintBadge = createOperatorHintBadge(entry.operator_explainer_hint);
      if (blockedHintBadge) {
        stopReasonCell.append(blockedHintBadge);
      }
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
      if (Array.isArray(entry.conflict_files) && entry.conflict_files.length) {
        const conflictTitle = document.createElement('div');
        conflictTitle.className = 'muted';
        conflictTitle.textContent = 'Conflict files';
        stopReasonCell.append(conflictTitle);
        const conflictChips = document.createElement('div');
        conflictChips.className = 'inline-badges';
        for (const conflict of entry.conflict_files) {
          const chip = document.createElement('span');
          chip.className = 'mini-badge ' + (conflict.status === 'staged' ? 'mini-badge-good' : 'mini-badge-bad');
          chip.textContent = conflict.path + ' (' + (conflict.status || 'unknown') + ')';
          conflictChips.append(chip);
        }
        stopReasonCell.append(conflictChips);
      }
      if (Array.isArray(entry.required_actions) && entry.required_actions.length) {
        const requiredActions = document.createElement('div');
        requiredActions.className = 'muted';
        requiredActions.textContent = 'Required actions: ' + entry.required_actions.join(', ');
        stopReasonCell.append(requiredActions);
      }
      const countWindow = document.createElement('div');
      countWindow.className = 'muted';
      countWindow.textContent =
        'Attempt window: ' +
        formatNumber(entry.attempt_count_window) +
        ' in ' +
        formatNumber(entry.window_minutes) +
        ' minute(s)';
      stopReasonCell.append(countWindow);
      const progressLine = document.createElement('div');
      progressLine.className = 'muted';
      progressLine.textContent =
        'Last progress: ' +
        (entry.last_known_commit_sha || 'n/a') +
        ' @ ' +
        (entry.last_progress_checkpoint_at ? formatDate(entry.last_progress_checkpoint_at) : 'n/a');
      stopReasonCell.append(progressLine);

      const previousSessionCell = document.createElement('td');
      const previousSessionValue = document.createElement('div');
      previousSessionValue.textContent = entry.previous_session_id || 'n/a';
      const previousThreadValue = document.createElement('div');
      previousThreadValue.className = 'muted';
      previousThreadValue.textContent = entry.previous_thread_id ? 'Thread ' + entry.previous_thread_id : 'Thread n/a';
      previousSessionCell.append(previousSessionValue, previousThreadValue);

      const actionsCell = document.createElement('td');
      const lastAction = Array.isArray(entry.operator_actions) && entry.operator_actions.length
        ? entry.operator_actions[entry.operator_actions.length - 1]
        : null;
      if (lastAction) {
        const actionOutcome = document.createElement('div');
        actionOutcome.className = 'muted';
        actionOutcome.textContent = 'Last action: ' + lastAction.action + ' ' + lastAction.result + (lastAction.result_code ? ' (' + lastAction.result_code + ')' : '');
        actionsCell.append(actionOutcome);
      }
      const resumeButton = createActionButton('Mark Acceptance Complete + Resume', 'ghost-button', function () {
        void resumeBlockedIssue(entry.issue_identifier);
      });
      const pushCommitResumeButton = createActionButton('Push Commit + Resume', 'ghost-button', function () {
        void resumeBlockedIssue(entry.issue_identifier, 'operator_override_push_additional_commit');
      });
      const cancelToBacklogButton = createActionButton('Cancel to Backlog', 'ghost-button', function () {
        void cancelBlockedIssue(entry.issue_identifier, 'operator_cancel_return_to_backlog');
      });
      const hasPendingInputRequest = Boolean(entry.pending_input && entry.pending_input.request_id);
      let replyButton = null;
      if (hasPendingInputRequest) {
        replyButton = createActionButton('Reply', 'ghost-button', function () {
          void submitBlockedInput(entry);
        });
      }
      const copyPreviousSession = createActionButton('Copy Prev Session', 'ghost-button', function () {
        copyText(entry.previous_session_id || '');
      });
      const copyWorkspace = createActionButton('Copy Workspace', 'ghost-button', function () {
        copyText(entry.workspace_path || '');
      });
      const openJson = createActionButton('JSON', 'ghost-button', function () {
        window.open('/api/v1/' + encodeURIComponent(entry.issue_identifier), '_blank', 'noopener');
      });
      const requeueButton = createActionButton('Requeue', 'ghost-button', function () {
        void runOperatorAction(entry.issue_identifier, 'requeue', false);
      });
      if (replyButton) {
        actionsCell.append(replyButton);
      } else {
        const manualResumeNote = document.createElement('div');
        manualResumeNote.className = 'muted';
        manualResumeNote.textContent = 'Manual resume required; no pending input request.';
        actionsCell.append(manualResumeNote);
      }
      actionsCell.append(resumeButton, pushCommitResumeButton, cancelToBacklogButton, requeueButton, copyPreviousSession, copyWorkspace, openJson);

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

  function recoveryStatusLabel(status) {
    switch (status) {
      case 'resume_available':
        return 'Resume available';
      case 'active_issue_present':
        return 'Active issue present';
      case 'capability_mismatch':
        return 'Capability mismatch';
      case 'resume_unavailable':
        return 'Resume unavailable';
      case 'inspect_forensics':
      default:
        return 'Inspect forensics';
    }
  }

  function renderStoppedRunRecovery(payload) {
    if (!state.stoppedRunRecoveryLoaded) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'Stopped-run recovery detail loads on demand.';
      elements.stoppedRunRecoveryList.replaceChildren(empty);
      return;
    }

    const acknowledged = new Set(JSON.parse(window.localStorage.getItem('symphony.stoppedRunAcknowledged') || '[]'));
    const entries = (payload.stopped_runs || []).filter(function (entry) {
      return !acknowledged.has(entry.run_id);
    });
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No recent stopped runs need recovery.';
      elements.stoppedRunRecoveryList.replaceChildren(empty);
      return;
    }

    const cards = entries.map((entry) => {
      const card = document.createElement('article');
      card.className = 'recovery-card' + (entry.capability_mismatch ? ' recovery-card-warning' : '');

      const header = document.createElement('div');
      header.className = 'recovery-card-head';
      const title = document.createElement('h3');
      title.textContent = entry.issue_identifier;
      const status = document.createElement('span');
      status.className = 'status-pill ' + (entry.resume_valid ? 'pending' : entry.capability_mismatch ? 'failed' : 'actionability-recommended');
      status.textContent = recoveryStatusLabel(entry.recovery_status);
      header.append(title, status);

      const meta = document.createElement('dl');
      meta.className = 'recovery-grid';
      const addMeta = function (label, value) {
        const group = document.createElement('div');
        const term = document.createElement('dt');
        term.textContent = label;
        const description = document.createElement('dd');
        description.textContent = value || 'n/a';
        group.append(term, description);
        meta.append(group);
      };
      addMeta('Run', entry.run_id);
      addMeta('Thread', entry.thread_id);
      addMeta('Session', entry.session_id);
      addMeta('Turn', entry.turn_id);
      addMeta('Last relevant', formatDate(entry.last_relevant_at));
      addMeta('Terminal', entry.terminal_status + (entry.terminal_reason_code ? ' / ' + entry.terminal_reason_code : ''));
      addMeta('Root cause', (entry.root_cause_status || 'unknown') + (entry.root_cause_reason_code ? ' / ' + getActionRequiredLabel(entry.root_cause_reason_code) : ''));
      addMeta('Current recovery', recoveryStatusLabel(entry.recovery_status));

      const detail = document.createElement('p');
      detail.className = 'muted';
      detail.textContent =
        'Terminal detail: ' +
        (entry.terminal_reason_detail || 'n/a') +
        ' | Root-cause detail: ' +
        (entry.root_cause_reason_detail || 'n/a');

      const capability = document.createElement('p');
      capability.className = entry.capability_mismatch ? 'capability-warning-text' : 'muted';
      capability.textContent = entry.capability_mismatch && entry.capability_warning
        ? 'Resume disabled: ' + entry.capability_warning.unsupported_capability_message + ' Recovery: ' + entry.capability_warning.recommended_recovery_action
        : (entry.resume_disabled_reason || 'Resume is available from API recovery metadata.');

      const actions = document.createElement('div');
      actions.className = 'action-cell recovery-actions';
      const inspect = createActionButton('Inspect Forensics', 'ghost-button', function () {
        window.open(entry.actions.inspect_forensics_url, '_blank', 'noopener');
      });
      const inspectThread = createActionButton('Inspect Thread', 'ghost-button', function () {
        if (entry.actions.inspect_thread_url) {
          window.open(entry.actions.inspect_thread_url, '_blank', 'noopener');
        }
      });
      inspectThread.disabled = !entry.actions.inspect_thread_url;
      const copyThread = createActionButton('Copy Thread', 'ghost-button', function () {
        copyText(entry.thread_id || '');
      });
      copyThread.disabled = !entry.actions.copy_thread_id_supported;
      const copySession = createActionButton('Copy Session', 'ghost-button', function () {
        copyText(entry.session_id || '');
      });
      copySession.disabled = !entry.actions.copy_session_id_supported;
      const resume = createActionButton('Resume', 'ghost-button', function () {
        if (entry.resume_valid) {
          void resumeBlockedIssue(entry.issue_identifier);
        }
      });
      resume.disabled = !entry.resume_valid;
      const acknowledge = createActionButton('Acknowledge Cancellation', 'ghost-button', function () {
        acknowledged.add(entry.run_id);
        window.localStorage.setItem('symphony.stoppedRunAcknowledged', JSON.stringify(Array.from(acknowledged)));
        renderStoppedRunRecovery(payload);
      });
      actions.append(inspect, inspectThread, copyThread, copySession, resume, acknowledge);

      card.append(header, meta, detail, capability, actions);
      return card;
    });

    elements.stoppedRunRecoveryList.replaceChildren(...cards);
  }

  function normalizeStoppedRunRecoveryPayload(recovery) {
    return {
      stopped_runs: recovery && Array.isArray(recovery.stopped_runs) ? recovery.stopped_runs : [],
      counts: {
        stopped:
          recovery && recovery.counts && typeof recovery.counts.stopped === 'number'
            ? recovery.counts.stopped
            : 0
      }
    };
  }

  function mergeStoppedRunRecoveryPayload(payload, recoveryPayload) {
    return {
      ...payload,
      stopped_runs: recoveryPayload.stopped_runs || [],
      counts: {
        ...payload.counts,
        stopped: recoveryPayload.counts && typeof recoveryPayload.counts.stopped === 'number' ? recoveryPayload.counts.stopped : 0
      }
    };
  }

  async function loadStoppedRunRecovery() {
    if (state.stoppedRunRecoveryLoading) {
      return;
    }
    state.stoppedRunRecoveryLoading = true;
    if (elements.stoppedRunRecoveryLoad) {
      elements.stoppedRunRecoveryLoad.disabled = true;
    }
    try {
      const recovery = await fetchJson('/api/v1/stopped-runs/recovery');
      state.stoppedRunRecoveryLoaded = true;
      state.stoppedRunRecoveryPayload = normalizeStoppedRunRecoveryPayload(recovery);
      if (state.payload) {
        state.payload = mergeStoppedRunRecoveryPayload(state.payload, state.stoppedRunRecoveryPayload);
        state.lastGoodPayload = state.payload;
        renderOverview(state.payload);
        renderStoppedRunRecovery(state.payload);
      } else {
        renderStoppedRunRecovery(state.stoppedRunRecoveryPayload);
      }
      setRefreshStatus('Stopped-run recovery loaded', false);
    } catch (error) {
      setRefreshStatus('Stopped-run recovery load failed: ' + String(error), true);
    } finally {
      state.stoppedRunRecoveryLoading = false;
      if (elements.stoppedRunRecoveryLoad) {
        elements.stoppedRunRecoveryLoad.disabled = false;
      }
    }
  }

  function applyPayload(payload, source) {
    if (payload && payload.error) {
      renderSnapshotError(payload.error);
      setLastUpdated(payload.generated_at || new Date().toISOString());
      return;
    }

    clearSnapshotError();
    if (state.stoppedRunRecoveryLoaded && state.stoppedRunRecoveryPayload) {
      payload = mergeStoppedRunRecoveryPayload(payload, state.stoppedRunRecoveryPayload);
    }
    state.payload = payload;
    state.lastGoodPayload = payload;
    renderOverview(payload);
    renderActionRequiredBanner(payload);
    renderApiDegradedBanner(payload);
    renderThroughput(payload);
    renderRunning(payload);
    renderRetry(payload);
    renderBlocked(payload);
    renderStoppedRunRecovery(payload);
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
      throw new Error(formatApiError(payload, 'Request failed'));
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

      if (state.selectedIssue && elements.issuePanel.open) {
        void loadIssue(state.selectedIssue, { openPanel: false });
      }
    } catch {
      state.uiStateLoaded = true;
    }
  }

  async function loadIssue(identifier, options) {
    const issueId = (identifier || '').trim();
    if (!issueId) {
      return;
    }
    const loadOptions = options || {};
    if (loadOptions.openPanel !== false && !elements.issuePanel.open) {
      state.suppressIssuePanelToggleLoad = true;
      elements.issuePanel.open = true;
      setTimeout(function () {
        state.suppressIssuePanelToggleLoad = false;
      }, 0);
    }

    try {
      const payload = await fetchJson('/api/v1/' + encodeURIComponent(issueId));
      let diagnostics = null;
      let diagnosticsLoadFailed = false;
      try {
        diagnostics = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueId) + '/diagnostics');
      } catch (_diagnosticsError) {
        diagnosticsLoadFailed = true;
        diagnostics = null;
      }
      state.selectedIssue = issueId;
      elements.issueInput.value = issueId;
      const summaryParts = [];
      summaryParts.push('Status: ' + (payload.status || 'unknown'));
      summaryParts.push('Snapshot: ' + (payload.snapshot_freshness_state || 'unknown') + ' age ' + formatNumber(payload.snapshot_age_ms) + 'ms');
      if (payload.api_degraded_mode) {
        summaryParts.push('API degraded: ' + (payload.api_degraded_reason_code || 'unknown'));
      }
      if (payload.workspace && payload.workspace.path) {
        summaryParts.push('Workspace: ' + payload.workspace.path);
      }
      if (payload.retry && payload.retry.stop_reason_code) {
        summaryParts.push('Stop reason: ' + payload.retry.stop_reason_code);
      }
      if (payload.blocked && payload.blocked.stop_reason_code) {
        summaryParts.push('Blocked reason: ' + getActionRequiredLabel(payload.blocked.stop_reason_code));
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
      if (payload.running && payload.running.turn_control_state) {
        summaryParts.push('Turn control: ' + getTurnControlLabel(payload.running.turn_control_state));
        summaryParts.push('Progress: ' + getProgressSignalLabel(payload.running.progress_signal_state));
      }
      if (payload.running && payload.running.token_telemetry_confidence) {
        summaryParts.push('Token quality: ' + getTokenConfidenceLabel(payload.running.token_telemetry_confidence));
      }
      if (payload.running && payload.running.not_blocked_explainer_text) {
        summaryParts.push('Why not blocked: ' + payload.running.not_blocked_explainer_text);
      }
      if (payload.blocked && payload.blocked.turn_control_state) {
        summaryParts.push('Turn control: ' + getTurnControlLabel(payload.blocked.turn_control_state));
      }
      if ((payload.retry && payload.retry.last_phase) || (payload.blocked && payload.blocked.last_phase)) {
        summaryParts.push('Last phase before stop: ' + ((payload.retry && payload.retry.last_phase) || (payload.blocked && payload.blocked.last_phase)));
      }
      if (payload.operator_explainer) {
        summaryParts.push('Actionability: ' + payload.operator_explainer.actionability);
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
      if (runningOrRetry) {
        summaryParts.push(formatBudgetSummary(runningOrRetry));
        summaryParts.push(formatDiagnosticSummary(getDiagnosticSummary(runningOrRetry)));
      }
      summaryParts.push(
        diagnostics
          ? 'Detailed diagnostics: loaded'
          : diagnosticsLoadFailed
            ? 'Detailed diagnostics: unavailable'
            : 'Detailed diagnostics: not loaded'
      );
      if (state.runtimeResolution && state.runtimeResolution.workspace_root) {
        summaryParts.push('Runtime workspace root: ' + state.runtimeResolution.workspace_root);
      }
      elements.issueSummary.textContent = summaryParts.join(' • ');
      renderIssueExplainer(payload.operator_explainer || null);
      renderThreadDiagnostics(diagnostics);
      const timeline = Array.isArray(payload.phase_timeline) ? payload.phase_timeline : [];
      const sessionConsole = payload.blocked && Array.isArray(payload.blocked.session_console) ? payload.blocked.session_console : [];
      const timelineText = timeline.length
        ? timeline.map(function (marker) {
            return marker.at + ' | ' + marker.phase + ' | attempt ' + marker.attempt + ' | ' + (marker.detail || 'n/a') + ' | thread ' + (marker.thread_id || 'n/a') + ' | session ' + (marker.session_id || 'n/a');
          }).join('\\n')
        : 'No phase markers yet.';
      const operatorTimelineRows = deriveOperatorTransitionRows(issueId, payload);
      const operatorActions = Array.isArray(payload.operator_actions) ? payload.operator_actions : [];
      const operatorActionText = operatorActions.length
        ? operatorActions.map(function (entry) {
            return new Date(entry.requested_at_ms).toISOString() + ' | ' + (entry.actor || 'operator') + ' | ' + entry.action + ' | ' + entry.result + ' | ' + (entry.result_code || 'n/a') + ' | ' + (entry.reason_note || 'no reason note') + ' | ' + (entry.message || 'n/a');
          }).join('\\n')
        : 'No operator action outcomes.';
      const operatorTimelineText = operatorTimelineRows.length
        ? operatorTimelineRows
            .map(function (entry) {
              return (
                entry.at +
                ' | ' +
                entry.label +
                ' | issue ' +
                entry.issue_identifier +
                ' | ' +
                entry.result +
                ' | ' +
                entry.detail
              );
            })
            .join('\\n')
        : 'No operator transition entries.';
      const sessionConsoleText = sessionConsole.length
        ? sessionConsole.map(function (event) {
            return event.at + ' | ' + event.event + ' | ' + (event.message || 'n/a');
          }).join('\\n')
        : 'No session console entries.';
      const budgetText = runningOrRetry ? formatBudgetSummary(runningOrRetry) : 'Budget: not configured';
      elements.issueOutput.textContent =
        'Operator Transition Timeline\\n' +
        operatorTimelineText +
        '\\n\\nOperator Action Outcomes\\n' +
        operatorActionText +
        '\\n\\nExecution Timeline\\n' +
        timelineText +
        '\\n\\nSession Console\\n' +
        sessionConsoleText +
        '\\n\\nBudget\\n' +
        budgetText +
        '\\n\\nIssue JSON\\n' +
        JSON.stringify(payload, null, 2);
      if (state.payload) {
        renderRunning(state.payload);
      }
      scheduleStateSave();
    } catch (error) {
      elements.issueSummary.textContent = 'Issue detail degraded: fallback mode active.';
      renderIssueExplainer(null);
      renderThreadDiagnostics(null);
      elements.issueOutput.textContent =
        'Issue load failed: ' +
        String(error) +
        '\\n\\nFallback message\\nIssue detail payload is unavailable. Available actions remain resume, cancel, refresh, and JSON inspection when the state snapshot contains the issue.';
    }
  }

  async function resumeBlockedIssue(issueIdentifier, resumeOverrideReason) {
    try {
      const reasonNote = window.prompt('Reason note for resuming this blocked issue', '');
      if (!reasonNote) {
        setRefreshStatus('Resume skipped: reason note is required', true);
        return;
      }
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueIdentifier) + '/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          resumeOverrideReason
            ? { resume_override_reason: resumeOverrideReason, reason_note: reasonNote }
            : { reason_note: reasonNote }
        )
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

  async function cancelBlockedIssue(issueIdentifier, cancelReason) {
    try {
      const reasonNote = window.prompt('Reason note for cancelling this blocked issue', cancelReason || '');
      if (!reasonNote) {
        setRefreshStatus('Cancel skipped: reason note is required', true);
        return;
      }
      if (!window.confirm('Cancel this blocked issue to backlog?')) {
        setRefreshStatus('Cancel skipped: confirmation declined', true);
        return;
      }
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueIdentifier) + '/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cancel_reason: cancelReason || reasonNote, reason_note: reasonNote, confirmed: true })
      });
      setRefreshStatus('Cancel requested for ' + payload.issue_identifier + ' -> ' + payload.moved_to_state, false);
      await loadStateViaPoll();
      if (state.selectedIssue === issueIdentifier) {
        await loadIssue(issueIdentifier);
      }
    } catch (error) {
      setRefreshStatus('Cancel failed: ' + String(error), true);
    }
  }

  async function runOperatorAction(issueIdentifier, actionPath, destructive) {
    try {
      const reasonNote = window.prompt('Reason note for ' + actionPath.replace('-', ' '), '');
      if (!reasonNote) {
        setRefreshStatus('Action skipped: reason note is required', true);
        return;
      }
      if (destructive && !window.confirm('Run destructive action "' + actionPath + '" for ' + issueIdentifier + '?')) {
        setRefreshStatus('Action skipped: confirmation declined', true);
        return;
      }
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(issueIdentifier) + '/' + actionPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason_note: reasonNote, confirmed: destructive ? true : undefined })
      });
      setRefreshStatus('Operator action requested for ' + (payload.issue_identifier || issueIdentifier), false);
      await loadStateViaPoll();
      if (state.selectedIssue === issueIdentifier) {
        await loadIssue(issueIdentifier);
      }
    } catch (error) {
      setRefreshStatus('Operator action failed: ' + String(error), true);
    }
  }

  async function submitBlockedInput(entry) {
    try {
      if (!entry.pending_input || !entry.pending_input.request_id) {
        throw new Error('No pending input request payload');
      }
      const pending = entry.pending_input;
      const firstQuestion = Array.isArray(pending.questions) && pending.questions.length ? pending.questions[0] : null;
      const questionId = firstQuestion && firstQuestion.id ? firstQuestion.id : undefined;
      let answer;
      if (pending.input_schema_type === 'options' && firstQuestion && Array.isArray(firstQuestion.options) && firstQuestion.options.length) {
        const labels = firstQuestion.options.map(function (option) { return option.label; });
        const selected = window.prompt((pending.prompt_text || 'Select option') + '\\nOptions: ' + labels.join(', '), labels[0] || '');
        answer = { question_id: questionId, option_label: selected || '' };
      } else {
        const text = window.prompt(pending.prompt_text || 'Enter response', '');
        answer = { question_id: questionId, text: text || '' };
      }
      const reasonNote = window.prompt('Reason note for submitting this blocked input', '');
      if (!reasonNote) {
        setRefreshStatus('Input submit skipped: reason note is required', true);
        return;
      }
      const payload = await fetchJson('/api/v1/issues/' + encodeURIComponent(entry.issue_identifier) + '/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          request_id: pending.request_id,
          reason_note: reasonNote,
          answer: answer
        })
      });
      setRefreshStatus(
        'Input submitted for ' +
          payload.issue_identifier +
          ' using ' +
          (payload.resume_mode || 'unknown') +
          ' mode (' +
          (payload.resume_reason_code || 'n/a') +
          ')',
        false
      );
      await loadStateViaPoll();
      if (state.selectedIssue === entry.issue_identifier) {
        await loadIssue(entry.issue_identifier);
      }
    } catch (error) {
      setRefreshStatus('Input submit failed: ' + String(error), true);
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

    if (elements.stoppedRunRecoveryLoad) {
      elements.stoppedRunRecoveryLoad.addEventListener('click', function () {
        void loadStoppedRunRecovery();
      });
    }

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
      if (state.filter.status !== 'blocked') {
        state.filter.blockedReason = 'all';
      }
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
      if (state.suppressIssuePanelToggleLoad) {
        state.suppressIssuePanelToggleLoad = false;
        scheduleStateSave();
        return;
      }
      if (elements.issuePanel.open && state.selectedIssue) {
        void loadIssue(state.selectedIssue, { openPanel: false });
      }
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

.mini-badge-bad {
  background: #f8e8e8;
  color: #8a2f2f;
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
