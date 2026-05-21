export function renderFormattingSource(): string {
  return `  function formatNumber(value) {
    if (!Number.isFinite(value)) {
      return '0';
    }
    return value.toLocaleString('en-US');
  }

  function localTimeZoneLabel() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
    } catch (_error) {
      return 'local time';
    }
  }

  function formatUtcIso(timestampMs) {
    if (!Number.isFinite(timestampMs)) {
      return 'n/a';
    }
    return new Date(timestampMs).toISOString();
  }

  function formatDate(value) {
    if (!value) {
      return 'n/a';
    }
    let parsed;
    if (typeof value === 'number' && Number.isFinite(value)) {
      parsed = value;
    } else {
      parsed = Date.parse(value);
    }
    if (!Number.isFinite(parsed)) {
      return String(value);
    }
    const local = new Date(parsed).toLocaleString(undefined, { timeZoneName: 'short' });
    return local + ' [' + localTimeZoneLabel() + '] (UTC ' + formatUtcIso(parsed) + ')';
  }

  function formatCanonicalJsonBlock(label, payload) {
    return label + ' (canonical UTC ISO values preserved)\\n' + JSON.stringify(payload, null, 2);
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
      case 'automation_fault':
        return 'Automation Fault';
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
      case 'active_but_opaque':
        return 'Active But Opaque';
      case 'stalled_waiting':
        return 'Stalled Waiting';
      default:
        return 'Progress Unknown';
    }
  }

  function getRetryStateLabel(entry) {
    if (entry && entry.due_state === 'overdue') {
      return 'Retry Overdue';
    }
    return 'Retry Scheduled';
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

  function getConnectionLabel(mode) {
    switch (mode) {
      case 'streaming':
        return 'Streaming';
      case 'polling':
        return 'Polling';
      case 'connecting':
        return 'Connecting';
      default:
        return 'Offline';
    }
  }

  function getConnectionClass(mode) {
    switch (mode) {
      case 'streaming':
        return 'badge badge-live';
      case 'polling':
        return 'badge badge-polling';
      case 'connecting':
        return 'badge badge-connecting';
      default:
        return 'badge badge-offline';
    }
  }

  function describeStreamFallback() {
    if (state.streamConnected && !state.streamSnapshotHealthy) {
      return 'SSE connected; waiting for first state_snapshot';
    }
    if (state.streamFallbackReason === 'error') {
      return 'SSE disconnected after stream error; polling fallback live';
    }
    if (state.streamFallbackReason === 'connecting') {
      return 'SSE connecting; polling fallback live';
    }
    return 'SSE disconnected; polling fallback live';
  }

  function setConnectionStatus(mode, detail) {
    state.connection = mode;
    elements.connectionBadge.textContent = getConnectionLabel(mode);
    elements.connectionBadge.className = getConnectionClass(mode);
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

  function isStreamHealthy() {
    return state.streamConnected && state.streamSnapshotHealthy;
  }

  function clearPollTimer() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function schedulePollingFallback() {
    clearPollTimer();
    if (isStreamHealthy()) {
      return;
    }
    state.pollTimer = setTimeout(loadStateViaPoll, state.pollDelayMs);
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

`;
}
