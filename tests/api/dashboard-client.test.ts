import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTION_REQUIRED_CODES, OPERATOR_TRANSITION_RULES } from '../../src/api/dashboard-client/config';
import {
  formatApiError,
  formatElapsedMs,
  formatNumber,
  formatOverviewTokenValue,
  formatTokenBreakdown,
  getActionRequiredLabel,
  getProgressSignalLabel,
  getRetryStateLabel,
  getTokenConfidenceLabel,
  getTurnControlLabel
} from '../../src/api/dashboard-client/formatting';
import {
  getConnectionClass,
  getConnectionLabel,
  handleSseEnvelope,
  loadDiagnostics,
  loadUiState,
  refreshNow,
  schedulePollingFallback,
  scheduleStateSave
} from '../../src/api/dashboard-client/connection';
import { elements, setDashboardElements } from '../../src/api/dashboard-client/dom';
import {
  formatDiagnosticSummary,
  formatInputDecisionContext,
  loadIssue,
  renderIssueExplainer,
  renderThreadDiagnostics,
  renderTimelineLane,
  spanLabel
} from '../../src/api/dashboard-client/issue-detail';
import { renderBlocked, renderRetry, renderRunning, rowMatchesFilter } from '../../src/api/dashboard-client/issues';
import {
  buildBlockedInputRequest,
  buildCancelRequest,
  buildDrainControlRequest,
  buildOperatorActionRequest,
  buildResumeRequest,
  cancelBlockedIssue,
  resumeBlockedIssue,
  runOperatorAction,
  waitForDrainQuiescence,
  submitBlockedInput
} from '../../src/api/dashboard-client/operator-actions';
import {
  computeDisplayRuntimeSeconds,
  deriveOperatorTransitionRows,
  describeTransition,
  renderActionRequiredBanner,
  renderApiDegradedBanner,
  renderOverview
} from '../../src/api/dashboard-client/overview';
import {
  createProjectHistoryEmptyRow,
  factClass,
  loadProjectHistory,
  loadProjectHistoryDetail,
  projectKeyFromHistoryPayload,
  renderProjectHistory,
  renderProjectHistoryDetail,
  summarizeProjectHistoryHealth,
  summarizeProjectHistoryMetrics,
  summarizeProjectHistoryReferences
} from '../../src/api/dashboard-client/project-history';
import { renderRuntimeEvents } from '../../src/api/dashboard-client/runtime';
import { resolveDashboardClientConstants } from '../../src/api/dashboard-client/server-config';
import {
  mergeStoppedRunRecoveryPayload,
  normalizeStoppedRunRecoveryPayload,
  loadStoppedRunRecovery,
  renderStoppedRunRecovery,
  recoveryStatusLabel
} from '../../src/api/dashboard-client/stopped-runs';
import { state } from '../../src/api/dashboard-client/state';

class FakeElement {
  textContent = '';
  className = '';
  title = '';
  type = '';
  colSpan = 0;
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  value = '';
  disabled = false;
  open = false;
  dataset: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};
  classList = {
    add: (...names: string[]) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      names.forEach((name) => classes.add(name));
      this.className = Array.from(classes).join(' ');
    },
    remove: (...names: string[]) => {
      const removeSet = new Set(names);
      this.className = this.className
        .split(/\s+/)
        .filter((name) => name && !removeSet.has(name))
        .join(' ');
    },
    contains: (name: string) => this.className.split(/\s+/).includes(name)
  };

  append(...children: FakeElement[]) {
    this.children.push(...children);
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]) {
    this.children = children;
  }

  setAttribute(name: string, value: string) {
    this.dataset[name] = value;
  }

  getAttribute(name: string) {
    return this.dataset[name] || null;
  }

  addEventListener(event: string, listener: Function) {
    this.listeners[event] = this.listeners[event] || [];
    this.listeners[event].push(listener);
  }

  click() {
    for (const listener of this.listeners.click || []) {
      listener({ stopPropagation: vi.fn() });
    }
  }

  select() {
    // no-op for copy fallback tests
  }
}

function makeDashboardElements() {
  return {
    connectionBadge: new FakeElement(),
    connectionDetail: new FakeElement(),
    lastUpdated: new FakeElement(),
    refreshButton: new FakeElement(),
    refreshStatus: new FakeElement(),
    healthMessage: new FakeElement(),
    lastError: new FakeElement(),
    actionRequiredBanner: new FakeElement(),
    actionRequiredTitle: new FakeElement(),
    actionRequiredSummary: new FakeElement(),
    actionRequiredGroups: new FakeElement(),
    runtimeStaleBanner: new FakeElement(),
    runtimeStaleTitle: new FakeElement(),
    runtimeStaleSummary: new FakeElement(),
    drainModePanel: new FakeElement(),
    drainModeSummary: new FakeElement(),
    drainModeBoundary: new FakeElement(),
    drainModeMeta: new FakeElement(),
    drainBlockersList: new FakeElement(),
    drainControlStatus: new FakeElement(),
    drainEnterButton: new FakeElement(),
    drainExitButton: new FakeElement(),
    drainWaitButton: new FakeElement(),
    drainShutdownButton: new FakeElement(),
    apiDegradedBanner: new FakeElement(),
    apiDegradedSummary: new FakeElement(),
    snapshotErrorPanel: new FakeElement(),
    snapshotErrorMessage: new FakeElement(),
    kpiGrid: new FakeElement(),
    retryStatusSummary: new FakeElement(),
    rateLimits: new FakeElement(),
    throughputPanel: new FakeElement(),
    throughputOutput: new FakeElement(),
    runtimeResolutionOutput: new FakeElement(),
    runningRows: new FakeElement(),
    retryRows: new FakeElement(),
    blockedRows: new FakeElement(),
    stoppedRunRecoveryList: new FakeElement(),
    stoppedRunRecoveryLoad: new FakeElement(),
    projectHistoryProjectKey: new FakeElement(),
    projectHistoryLoad: new FakeElement(),
    projectHistoryStatus: new FakeElement(),
    projectHistoryFacts: new FakeElement(),
    projectHistoryRows: new FakeElement(),
    projectHistoryDetail: new FakeElement(),
    statusFilter: new FakeElement(),
    runningFilter: new FakeElement(),
    issuePanel: new FakeElement(),
    issueInput: new FakeElement(),
    issueLoad: new FakeElement(),
    issueOpenJson: new FakeElement(),
    issueSummary: new FakeElement(),
    issueExplainerCard: new FakeElement(),
    issueExplainerActionability: new FakeElement(),
    issueExplainerHeadline: new FakeElement(),
    issueExplainerClassification: new FakeElement(),
    issueExplainerReason: new FakeElement(),
    issueExplainerAction: new FakeElement(),
    issueExplainerTransition: new FakeElement(),
    issueExplainerVersion: new FakeElement(),
    issueExplainerDetail: new FakeElement(),
    threadDetail: new FakeElement(),
    threadTimelineLanes: new FakeElement(),
    threadBlockerCard: new FakeElement(),
    threadCapabilityWarnings: new FakeElement(),
    threadRawEvents: new FakeElement(),
    issueOutput: new FakeElement(),
    runtimeEventsPanel: new FakeElement(),
    eventFeedFilter: new FakeElement(),
    runtimeEventsList: new FakeElement(),
    diagnosticsOutput: new FakeElement(),
    historyList: new FakeElement()
  };
}

function resetDashboardModuleState() {
  ACTION_REQUIRED_CODES.turn_input_required = 'Turn Input Required';
  OPERATOR_TRANSITION_RULES.eventMap['operator_resume_accepted'] = 'resume_accepted';
  OPERATOR_TRANSITION_RULES.eventMap['orchestration.blocked_input.resumed'] = 'resume_accepted';
  OPERATOR_TRANSITION_RULES.detailMap['resume accepted'] = 'resume_accepted';
  Object.assign(state, {
    payload: null,
    lastGoodPayload: null,
    selectedIssue: '',
    connection: 'offline',
    pollTimer: null,
    pollDelayMs: 4000,
    streamConnected: false,
    streamSnapshotHealthy: false,
    streamFallbackReason: 'connecting',
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
    runtimeResolution: null
  });
  setDashboardElements(makeDashboardElements());
  vi.stubGlobal('document', {
    createElement: () => new FakeElement(),
    querySelectorAll: () => []
  });
  const localStorageValues = new Map<string, string>([['symphony.stoppedRunAcknowledged', '[]']]);
  vi.stubGlobal('window', {
    prompt: vi.fn(() => 'reason note'),
    confirm: vi.fn(() => true),
    localStorage: {
      getItem: vi.fn((key: string) => localStorageValues.get(key) || null),
      setItem: vi.fn((key: string, value: string) => {
        localStorageValues.set(key, value);
      })
    },
    open: vi.fn()
  });
}

function jsonResponse(payload: any, ok = true) {
  return {
    ok,
    json: vi.fn().mockResolvedValue(payload)
  };
}

function snapshotPayload(overrides: any = {}) {
  return {
    generated_at: '2026-05-21T10:00:00.000Z',
    counts: {
      running: 0,
      retrying: 0,
      blocked: 0,
      stopped: 0,
      running_stalled_waiting_count: 0,
      running_awaiting_input_count: 0
    },
    codex_totals: {
      total_tokens: 100,
      input_tokens: 40,
      output_tokens: 60,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      model_context_window: 200000,
      seconds_running: 12
    },
    health: { dispatch_validation: 'ok' },
    retrying: [],
    blocked: [],
    running: [],
    recent_runtime_events: [],
    ...overrides
  };
}

function collectText(node: any): string {
  return [node.textContent, ...(node.children || []).map(collectText)].filter(Boolean).join(' ');
}

describe('dashboard browser client modules', () => {
  beforeEach(() => {
    resetDashboardModuleState();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('normalizes dashboard client config defaults and minimum values', () => {
    expect(
      resolveDashboardClientConstants({
        dashboard_enabled: undefined,
        refresh_ms: 10,
        render_interval_ms: 10,
        phase_stale_warn_ms: 10
      } as never).safeConfig
    ).toEqual({
      dashboard_enabled: true,
      refresh_ms: 500,
      render_interval_ms: 250,
      phase_stale_warn_ms: 1000
    });

    expect(resolveDashboardClientConstants({ dashboard_enabled: false } as never).safeConfig).toMatchObject({
      dashboard_enabled: false,
      refresh_ms: 4000,
      render_interval_ms: 1000,
      phase_stale_warn_ms: 45000
    });
  });

  it('formats numbers, durations, connection labels, and state labels directly', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(Number.NaN)).toBe('0');
    expect(formatElapsedMs(65000)).toBe('1m 5s');
    expect(formatElapsedMs(Number.NaN)).toBe('n/a');
    expect(getConnectionLabel('streaming')).toBe('Streaming');
    expect(getConnectionClass('polling')).toBe('badge badge-polling');
    expect(getTurnControlLabel('blocked_manual_resume')).toBe('Manual Resume Required');
    expect(getProgressSignalLabel('stalled_waiting')).toBe('Stalled Waiting');
    expect(getRetryStateLabel({ due_state: 'overdue' })).toBe('Retry Overdue');
    expect(getTokenConfidenceLabel('observed_live')).toBe('Live');
  });

  it('keeps aggregate-only token split behavior importable', () => {
    expect(
      formatOverviewTokenValue(
        {
          codex_totals: {
            token_split_status: 'aggregate_only',
            input_tokens: 0
          }
        },
        'input_tokens',
        'Split unavailable'
      )
    ).toBe('Split unavailable');

    expect(
      formatTokenBreakdown(
        {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 321,
          token_split_status: 'aggregate_only'
        },
        'codex_home_state_sqlite'
      )
    ).toContain('Split unavailable');
  });

  it('formats action-required labels and API errors without the generated asset', () => {
    expect(resolveDashboardClientConstants({} as never).actionRequiredReasonLabels.missing_tool_output_recovery_exhausted).toBe(
      'Missing Tool Output Recovery Exhausted'
    );
    expect(getActionRequiredLabel(null)).toBe('unknown');
    expect(formatApiError({ error: { code: 'bad_request', message: 'Bad request' } }, 'Request failed')).toBe(
      'bad_request: Bad request'
    );
    expect(formatApiError({ error: { message: 'Unavailable' } }, 'Request failed')).toBe('Unavailable');
    expect(formatApiError(null, 'Request failed')).toBe('Request failed');
  });

  it('exposes direct connection behavior for polling fallback and SSE refresh envelopes', () => {
    vi.useFakeTimers();

    state.streamConnected = true;
    state.streamSnapshotHealthy = true;
    schedulePollingFallback();
    expect(state.pollTimer).toBeNull();

    state.streamSnapshotHealthy = false;
    schedulePollingFallback();
    expect(state.pollTimer).not.toBeNull();

    handleSseEnvelope({ type: 'refresh_accepted', payload: { accepted: { coalesced: true } } });
    expect(elements.refreshStatus.textContent).toBe('Refresh request coalesced');
  });

  it('keeps issue row filtering importable for running, retry, blocked, query, and reason filters', () => {
    const entry = { issue_identifier: 'NIE-217', state: 'In Progress' };
    expect(rowMatchesFilter(entry)).toBe(true);

    state.filter.query = 'missing';
    expect(rowMatchesFilter(entry)).toBe(false);

    state.filter.query = 'NIE';
    state.filter.status = 'retrying';
    expect(rowMatchesFilter(entry)).toBe(false);

    state.filter.status = 'blocked';
    expect(rowMatchesFilter(entry)).toBe(false);
  });

  it('renders running, retry, and blocked table regions directly', () => {
    renderRunning({
      running: [
        {
          issue_identifier: 'NIE-217',
          state: 'In Progress',
          session_id: 'session-1',
          current_phase: 'implementation',
          started_at: '2026-05-21T10:00:00.000Z',
          turn_count: 2,
          tokens: { total_tokens: 321, input_tokens: 0, output_tokens: 0, token_split_status: 'aggregate_only' },
          token_telemetry_status: 'available',
          token_telemetry_confidence: 'observed_live',
          current_blocker_class: 'none',
          last_successful_step: 'tests',
          last_event_at: '2026-05-21T10:01:00.000Z'
        }
      ]
    });
    expect(collectText(elements.runningRows)).toContain('NIE-217');
    expect(collectText(elements.runningRows)).toContain('Split unavailable');

    renderRetry({ retrying: [] });
    expect(collectText(elements.retryRows)).toContain('No issues are waiting for retry.');

    renderBlocked({
      blocked: [
        {
          issue_identifier: 'NIE-217',
          attempt: 1,
          blocked_at: '2026-05-21T10:00:00.000Z',
          stop_reason_code: 'turn_input_required',
          pending_input: { request_id: 'req-1' }
        }
      ]
    });
    expect(collectText(elements.blockedRows)).toContain('NIE-217');
    expect(collectText(elements.blockedRows)).toContain('Reply');
  });

  it('renders runtime event empty and filtered states directly', () => {
    renderRuntimeEvents({ recent_runtime_events: [] });
    expect(collectText(elements.runtimeEventsList)).toContain('No runtime events.');

    state.filter.eventFeedSeverity = 'warn';
    renderRuntimeEvents({
      recent_runtime_events: [
        { severity: 'info', event: 'ignored', at: '2026-05-21T10:00:00.000Z' },
        { severity: 'warn', event: 'kept', at: '2026-05-21T10:00:00.000Z', detail: 'detail' }
      ]
    });
    expect(collectText(elements.runtimeEventsList)).toContain('[warn] kept');
    expect(collectText(elements.runtimeEventsList)).not.toContain('ignored');
  });

  it('constructs operator action request payloads directly', () => {
    expect(JSON.parse(buildResumeRequest('reviewed', 'operator_override').body)).toEqual({
      resume_override_reason: 'operator_override',
      reason_note: 'reviewed'
    });
    expect(JSON.parse(buildCancelRequest('cancel note', 'operator_cancel').body)).toEqual({
      cancel_reason: 'operator_cancel',
      reason_note: 'cancel note',
      confirmed: true
    });
    expect(JSON.parse(buildOperatorActionRequest('retry note', true).body)).toEqual({
      reason_note: 'retry note',
      confirmed: true
    });
    expect(JSON.parse(buildBlockedInputRequest({ request_id: 'req-1' }, 'answer note', { text: 'yes' }).body)).toEqual({
      request_id: 'req-1',
      reason_note: 'answer note',
      answer: { text: 'yes' }
    });
  });

  it('covers stopped-run recovery normalization, merge, and status labels directly', () => {
    expect(recoveryStatusLabel('resume_available')).toBe('Resume available');
    expect(normalizeStoppedRunRecoveryPayload({ stopped_runs: [{ run_id: 'run-1' }], counts: { stopped: 1 } })).toEqual({
      stopped_runs: [{ run_id: 'run-1' }],
      counts: { stopped: 1 }
    });
    expect(mergeStoppedRunRecoveryPayload({ counts: { running: 2 } }, { stopped_runs: [], counts: { stopped: 3 } })).toEqual({
      stopped_runs: [],
      counts: { running: 2, stopped: 3 }
    });

    setDashboardElements({ ...elements, stoppedRunRecoveryList: new FakeElement() });
    state.stoppedRunRecoveryLoaded = false;
    renderStoppedRunRecovery({ stopped_runs: [] });
    expect(collectText(elements.stoppedRunRecoveryList)).toContain('loads on demand');
  });

  it('covers project history summaries, fallback health text, and empty row rendering directly', () => {
    expect(projectKeyFromHistoryPayload({ runs: [{ identity: { project: { key: 'symphony' } } }] })).toBe('symphony');
    expect(summarizeProjectHistoryReferences({ summary: { evidence_reference_count: 1, tracker_snapshot_count: 2 } })).toContain(
      'evidence 1'
    );
    expect(summarizeProjectHistoryMetrics({ summary: { attempt_count: 2, total_tokens: null } })).toContain('tokens n/a');
    expect(summarizeProjectHistoryHealth({ status: 'degraded', enabled: true, diagnostics: [{ status: 'missing' }] })).toContain(
      'Health: degraded'
    );
    expect(factClass('present')).toContain('mini-badge-good');
    const row = createProjectHistoryEmptyRow('No project history.');
    expect(row.children[0].textContent).toBe('No project history.');
  });

  it('renders overview empty, aggregate-only, degraded, and action-required states directly', () => {
    vi.setSystemTime(new Date('2026-05-21T10:00:12.000Z'));

    renderOverview(
      snapshotPayload({
        generated_at: '2026-05-21T10:00:00.000Z',
        codex_totals: {
          total_tokens: 123,
          input_tokens: 0,
          output_tokens: 0,
          token_split_status: 'aggregate_only',
          seconds_running: 5
        },
        retry_status: {
          entries: [
            {
              issue_identifier: 'NIE-217',
              due_state: 'overdue',
              overdue_ms: 65000,
              reason_code: 'missing_tool_output',
              operator_detail: 'tool output missing'
            }
          ]
        }
      })
    );
    expect(collectText(elements.kpiGrid)).toContain('Split unavailable');
    expect(collectText(elements.kpiGrid)).toContain('Runtime Seconds 17');
    expect(collectText(elements.retryStatusSummary)).toContain('1 overdue retry needs attention');

    renderActionRequiredBanner({ blocked: [] });
    expect(elements.actionRequiredBanner.className).toContain('hidden');

    renderActionRequiredBanner({ blocked: [{ stop_reason_code: 'turn_input_required' }, { stop_reason_code: 'turn_input_required' }] });
    expect(elements.actionRequiredBanner.className).not.toContain('hidden');
    expect(elements.actionRequiredSummary.textContent).toBe('2 blocked runs need operator action.');
    expect(collectText(elements.actionRequiredGroups)).toContain('Turn Input Required (2)');

    renderApiDegradedBanner(null);
    expect(elements.apiDegradedBanner.className).toContain('hidden');
    renderApiDegradedBanner({ api_degraded_mode: true, api_degraded_reason_code: 'state_unavailable', api_degraded_routes: ['/api/v1/state'] });
    expect(elements.apiDegradedSummary.textContent).toBe('state_unavailable • fallback routes: /api/v1/state');

    expect(computeDisplayRuntimeSeconds(snapshotPayload({ codex_totals: { seconds_running: 5 } }))).toBe(17);
    expect(describeTransition('resume_accepted')).toMatchObject({ label: 'Resume Accepted', result: 'success' });
    expect(
      deriveOperatorTransitionRows('NIE-217', {
        recent_events: [{ at: '2026-05-21T10:00:00.000Z', event: 'operator_resume_accepted', message: 'resumed' }]
      })
    ).toEqual([
      {
        at: '2026-05-21T10:00:00.000Z',
        issue_identifier: 'NIE-217',
        label: 'Resume Accepted',
        result: 'success',
        detail: 'resumed'
      }
    ]);
  });

  it('renders Drain Mode and quiescence status prominently in the overview', () => {
    renderOverview(
      snapshotPayload({
        drain_mode: {
          active: true,
          entered_at: '2026-05-21T09:59:00.000Z',
          entered_at_ms: Date.parse('2026-05-21T09:59:00.000Z'),
          updated_at: '2026-05-21T10:00:00.000Z',
          updated_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          reason: 'safe runtime restart'
        },
        quiescence: {
          safe_to_shutdown: false,
          state: 'blocked',
          updated_at: '2026-05-21T10:00:00.000Z',
          updated_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          blocker_counts: {
            active_worker: 1,
            live_codex_app_server_process: 1,
            pending_retry: 1,
            in_flight_tracker_write: 0,
            persistence_history_write: 0,
            unknown_degraded_blocker_source_health: 0,
            stale_runtime: 0,
            unknown_current_build_identity: 0
          },
          blockers: [
            {
              category: 'active_worker',
              count: 1,
              detail: 'ABC-1 is still running',
              issue_identifiers: ['ABC-1']
            }
          ]
        }
      })
    );

    expect(elements.healthMessage.textContent).toContain('Drain Mode: active');
    expect(elements.healthMessage.textContent).toContain('restart blocked');
    expect(collectText(elements.kpiGrid)).toContain('Safe To Shutdown No');
    expect(collectText(elements.kpiGrid)).toContain('Drain Blockers 3');
    expect(elements.lastError.textContent).toContain('ABC-1 is still running');
  });

  it('renders Drain Mode workflow controls, blockers, stale warning context, and timeout results', async () => {
    renderOverview(
      snapshotPayload({
        drain_mode: {
          active: true,
          entered_at: '2026-05-21T09:59:00.000Z',
          entered_at_ms: Date.parse('2026-05-21T09:59:00.000Z'),
          updated_at: '2026-05-21T10:00:00.000Z',
          updated_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          reason: 'safe runtime restart'
        },
        runtime_identity: {
          health_warning: {
            code: 'stale_runtime_build',
            severity: 'warning',
            message: 'Running runtime build is stale',
            recommended_action: 'Enter Drain Mode, wait for quiescence, rebuild, and restart Symphony.'
          },
          running_build: { identity: 'old', commit_sha: 'old' },
          current_build: { identity: 'new', commit_sha: 'new' },
          process_started_at: '2026-05-21T09:00:00.000Z'
        },
        quiescence: {
          safe_to_shutdown: false,
          state: 'blocked',
          updated_at: '2026-05-21T10:00:00.000Z',
          updated_at_ms: Date.parse('2026-05-21T10:00:00.000Z'),
          blocker_counts: {
            active_worker: 2,
            live_codex_app_server_process: 1,
            pending_retry: 1,
            in_flight_tracker_write: 1,
            persistence_history_write: 1,
            unknown_degraded_blocker_source_health: 1,
            stale_runtime: 1,
            unknown_current_build_identity: 0
          },
          blockers: [
            { category: 'active_worker', count: 2, detail: 'ABC-1 and ABC-2 are still running', issue_identifiers: ['ABC-1', 'ABC-2'] },
            { category: 'live_codex_app_server_process', count: 1, detail: 'app server pid 123 is live', issue_identifiers: [] },
            { category: 'pending_retry', count: 1, detail: 'retry queue has one held item', issue_identifiers: ['ABC-3'] },
            { category: 'in_flight_tracker_write', count: 1, detail: 'tracker mutation is pending', issue_identifiers: ['ABC-4'] },
            { category: 'persistence_history_write', count: 1, detail: 'history write is pending', issue_identifiers: ['ABC-5'] },
            { category: 'unknown_degraded_blocker_source_health', count: 1, detail: 'blocker source health is degraded', issue_identifiers: [] },
            { category: 'stale_runtime', count: 1, detail: 'running code is stale', issue_identifiers: [] }
          ]
        }
      })
    );

    expect(elements.drainModeSummary.textContent).toContain('Drain Mode active');
    expect(elements.drainModeBoundary.textContent).toContain('Restart is not safe yet');
    expect(elements.drainModeBoundary.textContent).toContain('ABC-1 and ABC-2 are still running');
    expect(collectText(elements.drainBlockersList)).toContain('Active workers 2');
    expect(collectText(elements.drainBlockersList)).toContain('Codex app servers 1');
    expect(collectText(elements.drainBlockersList)).toContain('Pending retries 1');
    expect(collectText(elements.drainBlockersList)).toContain('Tracker writes 1');
    expect(collectText(elements.drainBlockersList)).toContain('Persistence/history writes 1');
    expect(collectText(elements.drainBlockersList)).toContain('Unknown/degraded source health 1');
    expect(collectText(elements.drainBlockersList)).toContain('Stale runtime 1');
    expect(elements.drainEnterButton.disabled).toBe(true);
    expect(elements.drainExitButton.disabled).toBe(true);
    expect(elements.drainWaitButton.disabled).toBe(false);
    expect(elements.drainShutdownButton.disabled).toBe(true);
    expect(elements.drainModeMeta.textContent).toContain('Dispatch is unsafe because this runtime is stale');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: false,
          status: 'timeout',
          reason: 'timeout',
          timed_out: true,
          waited_ms: 250,
          quiescence: {
            safe_to_shutdown: false,
            state: 'blocked',
            updated_at: '2026-05-21T10:00:01.000Z',
            updated_at_ms: Date.parse('2026-05-21T10:00:01.000Z'),
            blocker_counts: { active_worker: 1 },
            blockers: [{ category: 'active_worker', count: 1, detail: 'ABC-1 is still running', issue_identifiers: ['ABC-1'] }]
          },
          blockers: [{ category: 'active_worker', count: 1, issue_identifiers: ['ABC-1'], run_identifiers: [], reason: 'ABC-1 is still running' }]
        }, false)
      )
      .mockResolvedValueOnce(jsonResponse(snapshotPayload()));
    vi.stubGlobal('fetch', fetchMock);

    await waitForDrainQuiescence();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/drain-mode/wait', expect.objectContaining({ method: 'POST' }));
    expect(elements.drainControlStatus.textContent).toContain('Drain wait timed out');
    expect(elements.drainControlStatus.textContent).toContain('ABC-1 is still running');
    expect(elements.drainControlStatus.textContent).toContain('No forced cancel was requested');

    expect(buildDrainControlRequest('maintenance')).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' }
    });
  });

  it('renders a stale runtime warning above the overview', () => {
    renderOverview(
      snapshotPayload({
        runtime_identity: {
          process_started_at: '2026-05-21T09:00:00.000Z',
          process_started_at_ms: Date.parse('2026-05-21T09:00:00.000Z'),
          running_build: {
            identity: 'runtime-old',
            commit_sha: 'runtime-old',
            source_timestamp: '2026-05-21T08:55:00.000Z',
            source_timestamp_ms: Date.parse('2026-05-21T08:55:00.000Z')
          },
          current_build: {
            identity: 'current-new',
            commit_sha: 'current-new',
            source_timestamp: '2026-05-21T09:30:00.000Z',
            source_timestamp_ms: Date.parse('2026-05-21T09:30:00.000Z'),
            status: 'available'
          },
          status: 'stale',
          health_warning: {
            code: 'stale_runtime_build',
            severity: 'warning',
            message: 'Running runtime build runtime-old is stale compared with current-new',
            recommended_action: 'Enter Drain Mode, wait for quiescence, rebuild, and restart Symphony.'
          }
        }
      })
    );

    expect(elements.runtimeStaleBanner.className).not.toContain('hidden');
    expect(elements.runtimeStaleTitle.textContent).toBe('Runtime build is stale');
    expect(elements.runtimeStaleSummary.textContent).toContain('runtime-old');
    expect(elements.runtimeStaleSummary.textContent).toContain('current-new');
    expect(elements.runtimeStaleSummary.textContent).toContain('Process started');
    expect(elements.runtimeStaleSummary.textContent).toContain('Enter Drain Mode');
  });

  it('renders unknown current build identity as degraded rather than stale', () => {
    renderOverview(
      snapshotPayload({
        runtime_identity: {
          process_started_at: '2026-05-21T09:00:00.000Z',
          process_started_at_ms: Date.parse('2026-05-21T09:00:00.000Z'),
          running_build: {
            identity: 'runtime-sha',
            commit_sha: 'runtime-sha',
            source_timestamp: '2026-05-21T08:55:00.000Z',
            source_timestamp_ms: Date.parse('2026-05-21T08:55:00.000Z')
          },
          current_build: {
            identity: null,
            commit_sha: null,
            source_timestamp: null,
            source_timestamp_ms: null,
            status: 'unknown'
          },
          status: 'unknown_current',
          health_warning: {
            code: 'unknown_current_build_identity',
            severity: 'degraded',
            message: 'Current repository build identity is unavailable',
            recommended_action: 'Validate the repository checkout and rerun build identity detection before dispatching new work.'
          }
        }
      })
    );

    expect(elements.runtimeStaleBanner.className).not.toContain('hidden');
    expect(elements.runtimeStaleTitle.textContent).toBe('Runtime build identity unknown');
    expect(elements.runtimeStaleSummary.textContent).toContain('runtime-sha');
    expect(elements.runtimeStaleSummary.textContent).toContain('Current build unknown');
    expect(elements.runtimeStaleSummary.textContent).toContain('Validate the repository checkout');
  });

  it('handles refresh, diagnostics, UI state load/save, and SSE snapshot/error envelopes directly', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ coalesced: false }))
      .mockResolvedValueOnce(jsonResponse(snapshotPayload()))
      .mockResolvedValueOnce(jsonResponse({ runtime_resolution: { workspace_root: '/repo' } }))
      .mockResolvedValueOnce(jsonResponse({ runs: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          state: {
            selected_issue: 'NIE-217',
            filters: { status: 'blocked', query: 'manual' },
            event_feed_filter: 'warn',
            panels: { throughput_open: false, runtime_events_open: true },
            panel_state: { issue_detail_open: false }
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await refreshNow();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/refresh', { method: 'POST' });
    expect(elements.refreshStatus.textContent).toBe('Refresh queued');

    await loadDiagnostics();
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/v1/diagnostics', undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/v1/history?limit=8', undefined);
    expect(elements.diagnosticsOutput.textContent).toContain('Diagnostics JSON');
    expect(collectText(elements.historyList)).toContain('No run history available.');

    await loadUiState();
    expect(state.selectedIssue).toBe('NIE-217');
    expect(state.filter.status).toBe('blocked');
    expect(elements.throughputPanel.open).toBe(false);

    scheduleStateSave();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/ui-state',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"selected_issue":"NIE-217"')
      })
    );

    handleSseEnvelope({ type: 'state_snapshot', payload: { state: snapshotPayload({ counts: { running: 1, retrying: 0, blocked: 0 } }) } });
    expect(state.connection).toBe('streaming');
    expect(collectText(elements.kpiGrid)).toContain('Running 1');

    handleSseEnvelope({ type: 'runtime_health_changed', payload: { health: { dispatch_validation: 'failed', last_error: 'bad' } } });
    expect(elements.refreshStatus.textContent).toBe('Health changed: failed (bad)');

    handleSseEnvelope(null);
    expect(elements.refreshStatus.textContent).toBe('Health changed: failed (bad)');
  });

  it('recovers safely from UI state fetch failures and malformed payloads', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'missing' }, false))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonResponse({ state: null }));
    vi.stubGlobal('fetch', fetchMock);

    await loadUiState();
    expect(state.uiStateLoaded).toBe(true);

    state.uiStateLoaded = false;
    await loadUiState();
    expect(state.uiStateLoaded).toBe(true);

    state.uiStateLoaded = false;
    await loadUiState();
    expect(state.uiStateLoaded).toBe(true);
    expect(state.selectedIssue).toBe('');
  });

  it('renders issue detail diagnostics, timelines, raw events, and load fallbacks directly', async () => {
    expect(spanLabel({ phase: 'implementation' }, 'phase')).toBe('implementation');
    expect(spanLabel({ tool_name: 'apply_patch' }, 'tool')).toBe('apply_patch');
    expect(formatDiagnosticSummary(null)).toBe('Summary diagnostics: unavailable');
    expect(
      formatDiagnosticSummary({
        detailed_diagnostics_available: true,
        total_count: 2,
        active_missing_tool_output: { active: true, tool_name: 'shell' },
        recovery: { active: true, status: 'running' },
        newest_observed_at: '2026-05-21T10:00:00.000Z'
      })
    ).toContain('missing output shell');
    expect(formatInputDecisionContext('approval_option_exact')).toBe('Input handling: exact approval option selected');

    const lane = renderTimelineLane('Tool', [{ tool_name: 'shell', status: 'ok', duration_ms: 10 }], 'tool');
    expect(collectText(lane)).toContain('shell');
    expect(collectText(renderTimelineLane('Wait', [], 'wait'))).toContain('No wait spans.');

    renderIssueExplainer(null);
    expect(elements.issueExplainerCard.className).toContain('hidden');
    renderIssueExplainer({
      actionability: 'required',
      headline: 'Operator needed',
      classification: 'manual',
      reason_code: 'turn_input_required',
      reason_detail: 'answer prompt',
      recommended_actions: ['answer'],
      expected_transition: 'resume',
      version: '1'
    });
    expect(elements.issueExplainerHeadline.textContent).toBe('Operator needed');
    expect(elements.issueExplainerAction.textContent).toBe('answer');

    renderThreadDiagnostics(null);
    expect(elements.threadRawEvents.textContent).toBe('Detailed diagnostics are not loaded.');
    renderThreadDiagnostics({
      phase_spans: [{ phase: 'implementation', status: 'ok' }],
      tool_spans: [],
      wait_spans: [{ reason_code: 'waiting', status: 'open' }],
      current_blocker: { classification: 'input', reason_code: 'turn_input_required', recommended_actions: ['reply'] },
      capability_warnings: [{ reason_code: 'unsupported', attempted_tool_name: 'browser', unsupported_capability_message: 'no browser' }],
      timeline: [{ at_ms: 1779357600000, event: 'worker_event', thread_id: 'thread-1', reason_code: 'ok' }]
    });
    expect(collectText(elements.threadTimelineLanes)).toContain('implementation');
    expect(collectText(elements.threadCapabilityWarnings)).toContain('unsupported');
    expect(elements.threadRawEvents.textContent).toContain('worker_event');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'In Progress',
          snapshot_freshness_state: 'fresh',
          snapshot_age_ms: 10,
          running: {
            current_phase: 'implementation',
            token_telemetry_confidence: 'observed_live',
            transcript_tool_call_diagnostic_summary: { total_count: 1 }
          },
          phase_timeline: [{ at: '2026-05-21T10:00:00.000Z', phase: 'implementation', attempt: 1 }]
        })
      )
      .mockResolvedValueOnce(jsonResponse({ timeline: [] }))
      .mockRejectedValueOnce(new Error('issue down'));
    vi.stubGlobal('fetch', fetchMock);

    await loadIssue('NIE-217');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/NIE-217', undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/issues/NIE-217/diagnostics', undefined);
    expect(elements.issueSummary.textContent).toContain('Detailed diagnostics: loaded');
    expect(elements.issueOutput.textContent).toContain('Execution Timeline');

    await loadIssue('NIE-218');
    expect(elements.issueSummary.textContent).toBe('Issue detail degraded: fallback mode active.');
    expect(elements.issueOutput.textContent).toContain('Issue load failed: Error: issue down');
  });

  it('submits operator actions through direct module functions with endpoint and failure assertions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ issue_identifier: 'NIE-217' }))
      .mockResolvedValueOnce(jsonResponse(snapshotPayload()))
      .mockResolvedValueOnce(jsonResponse({ issue_identifier: 'NIE-217', moved_to_state: 'Backlog' }))
      .mockResolvedValueOnce(jsonResponse(snapshotPayload()))
      .mockResolvedValueOnce(jsonResponse({ issue_identifier: 'NIE-217' }))
      .mockResolvedValueOnce(jsonResponse(snapshotPayload()))
      .mockResolvedValueOnce(jsonResponse({ issue_identifier: 'NIE-217', resume_mode: 'normal', resume_reason_code: 'operator_input' }))
      .mockResolvedValueOnce(jsonResponse(snapshotPayload()));
    vi.stubGlobal('fetch', fetchMock);

    await resumeBlockedIssue('NIE-217', 'operator_override');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/issues/NIE-217/resume',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"resume_override_reason":"operator_override"') })
    );

    await cancelBlockedIssue('NIE-217', 'operator_cancel');
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/v1/issues/NIE-217/cancel',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"confirmed":true') })
    );

    await runOperatorAction('NIE-217', 'requeue', true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      '/api/v1/issues/NIE-217/requeue',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"reason_note":"reason note"') })
    );

    await submitBlockedInput({
      issue_identifier: 'NIE-217',
      pending_input: {
        request_id: 'req-1',
        input_schema_type: 'text',
        prompt_text: 'Answer?',
        questions: [{ id: 'q1' }]
      }
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      7,
      '/api/v1/issues/NIE-217/input',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"request_id":"req-1"') })
    );

    vi.mocked(window.prompt).mockReturnValueOnce('');
    await resumeBlockedIssue('NIE-218');
    expect(elements.refreshStatus.textContent).toBe('Resume skipped: reason note is required');
  });

  it('renders stopped-run recovery lazy, loading, loaded, acknowledgement, and API failure behavior directly', async () => {
    renderStoppedRunRecovery({ stopped_runs: [] });
    expect(collectText(elements.stoppedRunRecoveryList)).toContain('loads on demand');

    state.stoppedRunRecoveryLoaded = true;
    renderStoppedRunRecovery({
      stopped_runs: [
        {
          run_id: 'run-1',
          issue_identifier: 'NIE-217',
          recovery_status: 'resume_available',
          resume_valid: true,
          actions: { inspect_forensics_url: 'https://example.test', copy_thread_id_supported: true, copy_session_id_supported: true }
        }
      ]
    });
    expect(collectText(elements.stoppedRunRecoveryList)).toContain('NIE-217');
    const acknowledge = elements.stoppedRunRecoveryList.children[0].children[4].children[5];
    acknowledge.click();
    expect(window.localStorage.setItem).toHaveBeenCalledWith('symphony.stoppedRunAcknowledged', '["run-1"]');
    expect(collectText(elements.stoppedRunRecoveryList)).toContain('No recent stopped runs need recovery.');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ stopped_runs: [{ run_id: 'run-2', issue_identifier: 'NIE-218', actions: {} }], counts: { stopped: 1 } }))
      .mockRejectedValueOnce(new Error('recovery down'));
    vi.stubGlobal('fetch', fetchMock);
    state.payload = snapshotPayload();
    await loadStoppedRunRecovery();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/stopped-runs/recovery', undefined);
    expect(state.stoppedRunRecoveryLoaded).toBe(true);
    expect(elements.refreshStatus.textContent).toBe('Stopped-run recovery loaded');

    await loadStoppedRunRecovery();
    expect(elements.refreshStatus.textContent).toContain('Stopped-run recovery load failed');
  });

  it('loads and renders project history list/detail success, empty, fallback health, and errors directly', async () => {
    renderProjectHistory();
    expect(elements.projectHistoryStatus.textContent).toBe('No project key discovered from bounded run history yet.');

    state.projectHistory.projectKey = 'symphony';
    state.projectHistory.loading = true;
    renderProjectHistory();
    expect(collectText(elements.projectHistoryRows)).toContain('Loading project history...');

    state.projectHistory.loading = false;
    state.projectHistory.listPayload = {
      tickets: [
        {
          ticket_identity: { key: 'NIE-217', human_issue_identifier: 'NIE-217' },
          state: 'In Progress',
          current_status: 'In Progress',
          latest_attempt: { attempt_number: 1, status: 'running', started_at: '2026-05-21T10:00:00.000Z' },
          summary: { evidence_reference_count: 1, attempt_count: 1, total_tokens: 10 },
          facts: [{ status: 'present', fact: 'workspace' }],
          latest_observed_at: '2026-05-21T10:00:00.000Z'
        }
      ],
      page: { total: 1, has_more: false },
      facts: [{ status: 'present', fact: 'history' }],
      health: { status: 'ok', enabled: true, counts: { runs: 1 } }
    };
    renderProjectHistory();
    expect(collectText(elements.projectHistoryRows)).toContain('NIE-217');
    expect(collectText(elements.projectHistoryFacts)).toContain('present: history');

    state.projectHistory.detailPayload = {
      ticket_identity: { key: 'NIE-217', human_issue_identifier: 'NIE-217' },
      facts: [{ status: 'present', fact: 'timeline' }],
      attempts: [{ attempt_number: 1, status: 'running', started_at: '2026-05-21T10:00:00.000Z' }],
      phases: [],
      state_transitions: [],
      thread_references: [],
      turn_references: [],
      outcomes: [],
      blockers: [],
      evidence_references: [],
      app_server_lite_summaries: [],
      token_model_summaries: [],
      blocked_input_events: []
    };
    renderProjectHistoryDetail();
    expect(collectText(elements.projectHistoryDetail)).toContain('Ticket Timeline: NIE-217');
    expect(collectText(elements.projectHistoryDetail)).toContain('No phases facts recorded.');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ tickets: [], page: { total: 0 }, health: { status: 'ok' } }))
      .mockResolvedValueOnce(jsonResponse({ ticket_identity: { key: 'NIE-217' }, attempts: [], phases: [] }))
      .mockRejectedValueOnce(new Error('list down'))
      .mockResolvedValueOnce(jsonResponse({ status: 'degraded', enabled: true, diagnostics: [{ status: 'missing' }] }))
      .mockRejectedValueOnce(new Error('detail down'));
    vi.stubGlobal('fetch', fetchMock);

    await loadProjectHistory('symphony');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/projects/symphony/history/tickets?limit=50', undefined);
    expect(collectText(elements.projectHistoryRows)).toContain('No project ticket history available for this project.');

    await loadProjectHistoryDetail('NIE-217');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/projects/symphony/history/tickets/NIE-217', undefined);

    await loadProjectHistory('symphony');
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/v1/projects/symphony/history/health', undefined);
    expect(elements.projectHistoryStatus.textContent).toContain('Project history unavailable');

    state.projectHistory.error = null;
    state.projectHistory.listPayload = { tickets: [], page: { total: 0 } };
    await loadProjectHistoryDetail('NIE-218');
    expect(state.projectHistory.detailError).toContain('detail down');
    renderProjectHistoryDetail();
    expect(elements.projectHistoryDetail.className).not.toContain('hidden');
    expect(collectText(elements.projectHistoryDetail)).toContain('Ticket timeline unavailable');
  });
});
