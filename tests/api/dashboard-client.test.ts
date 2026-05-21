import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { getConnectionClass, getConnectionLabel } from '../../src/api/dashboard-client/connection';
import { handleSseEnvelope, schedulePollingFallback } from '../../src/api/dashboard-client/connection';
import { elements, setDashboardElements } from '../../src/api/dashboard-client/dom';
import { renderBlocked, renderRetry, renderRunning, rowMatchesFilter } from '../../src/api/dashboard-client/issues';
import {
  buildBlockedInputRequest,
  buildCancelRequest,
  buildOperatorActionRequest,
  buildResumeRequest
} from '../../src/api/dashboard-client/operator-actions';
import {
  createProjectHistoryEmptyRow,
  factClass,
  projectKeyFromHistoryPayload,
  summarizeProjectHistoryHealth,
  summarizeProjectHistoryMetrics,
  summarizeProjectHistoryReferences
} from '../../src/api/dashboard-client/project-history';
import { renderRuntimeEvents } from '../../src/api/dashboard-client/runtime';
import { resolveDashboardClientConstants } from '../../src/api/dashboard-client/server-config';
import {
  mergeStoppedRunRecoveryPayload,
  normalizeStoppedRunRecoveryPayload,
  renderStoppedRunRecovery,
  recoveryStatusLabel
} from '../../src/api/dashboard-client/stopped-runs';
import { state } from '../../src/api/dashboard-client/state';

class FakeElement {
  textContent = '';
  className = '';
  classList = {
    add: vi.fn(),
    remove: vi.fn()
  };
  children: FakeElement[] = [];
  value = '';
  disabled = false;
  open = false;
  dataset: Record<string, string> = {};

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

  addEventListener() {
    // no-op for direct module tests
  }
}

function resetDashboardModuleState() {
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
    }
  });
  setDashboardElements({
    runningRows: new FakeElement(),
    retryRows: new FakeElement(),
    blockedRows: new FakeElement(),
    refreshStatus: new FakeElement(),
    issueInput: new FakeElement(),
    runtimeEventsList: new FakeElement(),
    projectHistoryProjectKey: new FakeElement(),
    projectHistoryLoad: new FakeElement(),
    projectHistoryStatus: new FakeElement(),
    projectHistoryFacts: new FakeElement(),
    projectHistoryRows: new FakeElement(),
    projectHistoryDetail: new FakeElement()
  });
  vi.stubGlobal('document', {
    createElement: () => new FakeElement()
  });
  vi.stubGlobal('window', {
    localStorage: {
      getItem: vi.fn(() => '[]'),
      setItem: vi.fn()
    },
    open: vi.fn()
  });
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
});
