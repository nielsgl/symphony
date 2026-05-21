import { DASHBOARD_CONFIG } from './config';

export const state: any = {
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
