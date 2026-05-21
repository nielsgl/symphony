export function renderConnectionSource(): string {
  return `  function applyPayload(payload, source) {
    if (payload && payload.error) {
      renderSnapshotError(payload.error);
      setLastUpdated(payload.generated_at || new Date().toISOString());
      return false;
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
      state.streamSnapshotHealthy = true;
      state.streamStatus = 'streaming';
      state.streamFallbackReason = null;
      setConnectionStatus('streaming', 'SSE streaming live state_snapshot updates');
      state.pollDelayMs = DASHBOARD_CONFIG.refresh_ms;
      clearPollTimer();
    }
    return true;
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
      const usablePayload = applyPayload(payload, 'poll');
      if (isStreamHealthy()) {
        setConnectionStatus('streaming', 'SSE streaming live state_snapshot updates');
      } else if (usablePayload) {
        setConnectionStatus('polling', describeStreamFallback());
      } else {
        setConnectionStatus('offline', 'Polling returned snapshot error');
      }
      state.pollDelayMs = DASHBOARD_CONFIG.refresh_ms;
    } catch (error) {
      setConnectionStatus('offline', 'Polling failed');
      setRefreshStatus('Polling failed: ' + String(error), true);
      state.pollDelayMs = Math.min(state.pollDelayMs * 2, 30000);
    } finally {
      schedulePollingFallback();
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

`;
}

export function renderConnectionRuntimeSource(): string {
  return `  async function refreshNow() {
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
      elements.diagnosticsOutput.textContent = formatCanonicalJsonBlock('Diagnostics JSON', diagnostics);
      renderRuntimeResolution(state.runtimeResolution);
    } catch {
      elements.diagnosticsOutput.textContent = 'Diagnostics unavailable.';
      state.runtimeResolution = null;
      renderRuntimeResolution(null);
    }

    try {
      const historyPayload = await fetchJson('/api/v1/history?limit=8');
      const discoveredProjectKey = projectKeyFromHistoryPayload(historyPayload);
      if (discoveredProjectKey && !state.projectHistory.projectKey) {
        state.projectHistory.projectKey = discoveredProjectKey;
        void loadProjectHistory(discoveredProjectKey);
      } else {
        renderProjectHistory();
      }
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
    state.streamStatus = 'connecting';
    state.streamFallbackReason = 'connecting';
    setConnectionStatus('connecting', 'SSE connecting; polling fallback active until first snapshot');

    stream.onopen = function () {
      state.streamConnected = true;
      state.streamSnapshotHealthy = false;
      state.streamStatus = 'connected_waiting_snapshot';
      state.streamFallbackReason = 'waiting_first_snapshot';
      state.streamRetryMs = 1000;
      setConnectionStatus('connecting', 'SSE connected; waiting for first state_snapshot');
    };

    function handleStreamMessage(event) {
      try {
        const envelope = JSON.parse(event.data);
        handleSseEnvelope(envelope);
      } catch {
        // Ignore malformed envelopes.
      }
    }

    stream.onmessage = handleStreamMessage;
    stream.addEventListener('symphony', handleStreamMessage);

    stream.onerror = function () {
      state.streamConnected = false;
      state.streamSnapshotHealthy = false;
      state.streamStatus = 'error';
      state.streamFallbackReason = 'error';
      setConnectionStatus('connecting', 'SSE disconnected after stream error; polling fallback active');
      stream.close();
      state.eventSource = null;
      void loadStateViaPoll();
      setTimeout(connectStream, state.streamRetryMs);
      state.streamRetryMs = Math.min(state.streamRetryMs * 2, 15000);
    };
  }

`;
}
