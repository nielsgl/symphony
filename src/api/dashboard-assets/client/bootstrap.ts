import type { DashboardClientConstants } from './config';

export function renderBootstrapStartSource(constants: DashboardClientConstants): string {
  return `(() => {
  const DASHBOARD_CONFIG = __DASHBOARD_CONFIG__;
  const ACTION_REQUIRED_CODES = __ACTION_REQUIRED_CODES__;
  const OPERATOR_TRANSITION_RULES = __OPERATOR_TRANSITION_RULES__;
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
    streamSnapshotHealthy: false,
    streamStatus: 'connecting',
    streamFallbackReason: 'connecting',
    eventSource: null,
    uiStateLoaded: false,
    uiStateSaveTimer: null,
    stoppedRunRecoveryLoaded: false,
    stoppedRunRecoveryLoading: false,
    stoppedRunRecoveryPayload: null,
    projectHistory: {
      projectKey: '',
      loading: false,
      detailLoadingTicketKey: null,
      listPayload: null,
      healthPayload: null,
      detailPayload: null,
      error: null,
      detailError: null
    },
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
    retryStatusSummary: document.getElementById('retry-status-summary'),
    rateLimits: document.getElementById('rate-limits'),
    throughputPanel: document.getElementById('throughput-panel'),
    throughputOutput: document.getElementById('throughput-output'),
    runtimeResolutionOutput: document.getElementById('runtime-resolution-output'),
    runningRows: document.getElementById('running-rows'),
    retryRows: document.getElementById('retry-rows'),
    blockedRows: document.getElementById('blocked-rows'),
    stoppedRunRecoveryList: document.getElementById('stopped-run-recovery-list'),
    stoppedRunRecoveryLoad: document.getElementById('stopped-run-recovery-load'),
    projectHistoryProjectKey: document.getElementById('project-history-project-key'),
    projectHistoryLoad: document.getElementById('project-history-load'),
    projectHistoryStatus: document.getElementById('project-history-status'),
    projectHistoryFacts: document.getElementById('project-history-facts'),
    projectHistoryRows: document.getElementById('project-history-rows'),
    projectHistoryDetail: document.getElementById('project-history-detail'),
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

`
    .replace('__DASHBOARD_CONFIG__', JSON.stringify(constants.safeConfig))
    .replace('__ACTION_REQUIRED_CODES__', constants.actionRequiredReasonLabels)
    .replace('__OPERATOR_TRANSITION_RULES__', constants.operatorTransitionRules);
}

export function renderBootstrapStartupSource(): string {
  return `  function wireEvents() {
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

    elements.projectHistoryLoad.addEventListener('click', function () {
      void loadProjectHistory(elements.projectHistoryProjectKey.value);
    });

    elements.projectHistoryProjectKey.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        void loadProjectHistory(elements.projectHistoryProjectKey.value);
      }
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
