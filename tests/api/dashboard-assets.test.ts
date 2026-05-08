import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderDashboardClientJs, renderDashboardHtml } from '../../src/api/dashboard-assets';

const ORIGINAL_GLOBALS = {
  document: globalThis.document,
  window: globalThis.window,
  EventSource: globalThis.EventSource,
  fetch: globalThis.fetch,
  setInterval: globalThis.setInterval
};

class FakeClassList {
  add() {}
  remove() {}
  toggle() {}
  contains() {
    return false;
  }
}

class FakeElement {
  textContent = '';
  className = '';
  value = '';
  open = false;
  disabled = false;
  title = '';
  href = '';
  type = '';
  colSpan = 0;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = new FakeClassList();
  listeners = new Map<string, Array<(event?: Record<string, unknown>) => void>>();
  children: FakeElement[] = [];

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

  addEventListener(type: string, listener: (event?: Record<string, unknown>) => void) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }

  setAttribute(name: string, value: string) {
    if (name.startsWith('data-')) {
      this.dataset[name.slice('data-'.length)] = value;
    }
  }

  getAttribute(name: string) {
    if (name.startsWith('data-')) {
      return this.dataset[name.slice('data-'.length)] || null;
    }
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

function makeStatePayload() {
  return {
    generated_at: '2026-05-08T15:00:00.000Z',
    snapshot_generated_at_ms: Date.parse('2026-05-08T15:00:00.000Z'),
    snapshot_age_ms: 0,
    snapshot_freshness_state: 'fresh',
    api_degraded_mode: false,
    api_degraded_reason_code: null,
    api_degraded_routes: [],
    counts: {
      running: 0,
      retrying: 0,
      blocked: 0,
      stopped: 0,
      running_stalled_waiting_count: 0,
      running_awaiting_input_count: 0
    },
    codex_totals: {
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      seconds_running: 0
    },
    rate_limits: null,
    throughput: null,
    running: [],
    retrying: [],
    blocked: [],
    stopped_runs: [],
    recent_runtime_events: [],
    health: {
      dispatch_validation: 'ok',
      last_error: null
    }
  };
}

function okJson(payload: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => payload
  } as Response);
}

async function flushPromises() {
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function installDashboardClientHarness() {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  const elements = new Map<string, FakeElement>();
  const fetchCalls: string[] = [];
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) {
        elements.set(id, new FakeElement());
      }
      return elements.get(id);
    },
    createElement() {
      return new FakeElement();
    },
    createTextNode(value: string) {
      const node = new FakeElement();
      node.textContent = value;
      return node;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    activeElement: null
  };
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    fetchCalls.push(String(url));
    if (url === '/api/v1/state') {
      return okJson(makeStatePayload());
    }
    if (url === '/api/v1/refresh') {
      expect(init?.method).toBe('POST');
      return okJson({ queued: true, coalesced: false });
    }
    if (url === '/api/v1/ui-state') {
      return okJson({ state: null });
    }
    if (url === '/api/v1/diagnostics') {
      return okJson({ runtime_resolution: null });
    }
    if (url === '/api/v1/history?limit=8') {
      return okJson({ runs: [] });
    }
    return okJson({});
  });

  vi.stubGlobal('document', document);
  vi.stubGlobal('window', {
    open: vi.fn(),
    localStorage: {
      getItem: vi.fn(() => null),
      setItem: vi.fn()
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', FakeEventSource);

  const script = renderDashboardClientJs({ dashboard_enabled: true, refresh_ms: 500, render_interval_ms: 500, phase_stale_warn_ms: 1000 });
  Function(script)();

  return {
    elements,
    fetchCalls,
    stateFetchCount: () => fetchCalls.filter((url) => url === '/api/v1/state').length,
    refreshFetchCount: () => fetchCalls.filter((url) => url === '/api/v1/refresh').length,
    stream: () => {
      const stream = FakeEventSource.instances.at(-1);
      expect(stream).toBeDefined();
      return stream!;
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (ORIGINAL_GLOBALS.document) {
    globalThis.document = ORIGINAL_GLOBALS.document;
  }
  if (ORIGINAL_GLOBALS.window) {
    globalThis.window = ORIGINAL_GLOBALS.window;
  }
  if (ORIGINAL_GLOBALS.EventSource) {
    globalThis.EventSource = ORIGINAL_GLOBALS.EventSource;
  }
  if (ORIGINAL_GLOBALS.fetch) {
    globalThis.fetch = ORIGINAL_GLOBALS.fetch;
  }
  globalThis.setInterval = ORIGINAL_GLOBALS.setInterval;
});

describe('dashboard assets', () => {
  it('renders client budget display logic for visible status, policy, and stop messages', () => {
    const clientJs = renderDashboardClientJs();

    expect(clientJs).toContain('function createBudgetBlock(entry)');
    expect(clientJs).toContain('Budget: ');
    expect(clientJs).toContain('Budget usage unavailable; not counted as zero.');
    expect(clientJs).toContain('Policy ');
    expect(clientJs).toContain('Budget stopped continuation: ');
    expect(clientJs).toContain('tokensCell.append(createBudgetBlock(entry));');
    expect(clientJs.split('stopReasonCell.append(createBudgetBlock(entry));')).toHaveLength(3);
    expect(clientJs).toContain("'\\n\\nBudget\\n' +");
  });

  it('renders dashboard drilldown contract surfaces and row-level blocker fields', () => {
    const html = renderDashboardHtml();
    const clientJs = renderDashboardClientJs();

    expect(html).toContain('<th>Blocker</th>');
    expect(html).toContain('<th>Time Since Progress</th>');
    expect(html).toContain('<th>Last Successful Step</th>');
    expect(html).toContain('id="thread-timeline-lanes"');
    expect(html).toContain('id="thread-blocker-card"');
    expect(html).toContain('id="thread-capability-warnings"');
    expect(html).toContain('id="thread-raw-events"');
    expect(clientJs).toContain("fetchJson('/api/v1/issues/' + encodeURIComponent(issueId) + '/diagnostics')");
    expect(clientJs.split("fetchJson('/api/v1/issues/' + encodeURIComponent(issueId) + '/diagnostics')")).toHaveLength(2);
    expect(clientJs).toContain('function formatDiagnosticSummary(summary)');
    expect(clientJs).toContain('Summary diagnostics: ');
    expect(clientJs).toContain('Detailed diagnostics: loaded');
    expect(clientJs).toContain('Detailed diagnostics: unavailable');
    expect(clientJs).toContain("elements.threadRawEvents.textContent = 'Detailed diagnostics are not loaded.'");
    expect(clientJs).toContain("renderTimelineLane('Phase'");
    expect(clientJs).toContain("appendDefinitionValue(elements.threadBlockerCard, 'classification'");
    expect(clientJs).toContain('diagnostics.capability_warnings');
    expect(clientJs).toContain('recommended_recovery_action');
    expect(clientJs).toContain("appendDefinitionValue(elements.threadBlockerCard, 'recovery_headline'");
    expect(clientJs).toContain("appendDefinitionValue(elements.threadBlockerCard, 'recovery_next_action'");
    expect(clientJs).toContain('missing_tool_output_recovery');
    expect(clientJs).toContain('entry.current_blocker_class');
    expect(clientJs).toContain('entry.time_since_progress');
    expect(clientJs).toContain('entry.last_successful_step');
    expect(clientJs).toContain('entry.transcript_tool_call_diagnostic_summary');
    expect(clientJs).toContain('blockerCell.append(blockerValue, diagnosticSummary);');
  });

  it('lazy-loads issue diagnostics only for opened detail surfaces', () => {
    const clientJs = renderDashboardClientJs();
    const restoreBlock = clientJs.slice(clientJs.indexOf('async function loadUiState()'), clientJs.indexOf('async function loadIssue'));
    const refreshBlock = clientJs.slice(clientJs.indexOf('async function refreshNow()'), clientJs.indexOf('async function loadDiagnostics()'));
    const streamBlock = clientJs.slice(clientJs.indexOf('function handleSseEnvelope'), clientJs.indexOf('function connectStream'));

    expect(restoreBlock).toContain('if (state.selectedIssue && elements.issuePanel.open)');
    expect(restoreBlock).toContain("void loadIssue(state.selectedIssue, { openPanel: false });");
    expect(restoreBlock).not.toContain('if (state.selectedIssue) {\n        void loadIssue(state.selectedIssue);');
    expect(clientJs).toContain("elements.issuePanel.addEventListener('toggle'");
    expect(clientJs).toContain('state.suppressIssuePanelToggleLoad');
    expect(clientJs).toContain("void loadIssue(state.selectedIssue, { openPanel: false });");
    expect(clientJs).toContain('if (loadOptions.openPanel !== false && !elements.issuePanel.open)');
    expect(refreshBlock).toContain("fetchJson('/api/v1/refresh'");
    expect(refreshBlock).not.toContain('/diagnostics');
    expect(streamBlock).toContain("type === 'state_snapshot'");
    expect(streamBlock).not.toContain('/diagnostics');
  });

  it('keeps polling before the stream delivers a usable state snapshot', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    expect(harness.stateFetchCount()).toBe(1);
    harness.stream().onopen?.();
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(harness.stateFetchCount()).toBe(2);
  });

  it('suspends routine polling after a healthy stream state snapshot arrives', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state: makeStatePayload() } })
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();

    expect(harness.stateFetchCount()).toBe(1);
    expect(harness.elements.get('connection-detail')?.textContent).toBe('Streaming updates connected');
  });

  it('resumes fallback polling when the stream errors after a healthy snapshot', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state: makeStatePayload() } })
    });
    await flushPromises();
    expect(harness.stateFetchCount()).toBe(1);

    harness.stream().onerror?.();
    await flushPromises();
    expect(harness.stateFetchCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(harness.stateFetchCount()).toBe(3);
  });

  it('keeps manual refresh explicit while stream polling is suspended', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state: makeStatePayload() } })
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(harness.stateFetchCount()).toBe(1);

    harness.elements.get('refresh-button')?.dispatch('click');
    await flushPromises();

    expect(harness.refreshFetchCount()).toBe(1);
    expect(harness.stateFetchCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(harness.stateFetchCount()).toBe(2);
  });

  it('snapshots the stuck drilldown rendering vocabulary', () => {
    const clientJs = renderDashboardClientJs();
    const stuckVocabulary = [
      'Blocker Intelligence',
      'Raw Event Stream',
      'expected_auto_transition',
      'time_since_progress',
      'recommended_actions',
      'No raw event stream entries.'
    ].filter((token) => clientJs.includes(token) || renderDashboardHtml().includes(token));

    expect(stuckVocabulary).toMatchInlineSnapshot(`
      [
        "Blocker Intelligence",
        "Raw Event Stream",
        "expected_auto_transition",
        "time_since_progress",
        "recommended_actions",
        "No raw event stream entries.",
      ]
    `);
  });

  it('renders reason-note prompts for blocked resume and input submission actions', () => {
    const clientJs = renderDashboardClientJs();

    expect(clientJs).toContain("window.prompt('Reason note for resuming this blocked issue'");
    expect(clientJs).toContain("resume_override_reason: resumeOverrideReason, reason_note: reasonNote");
    expect(clientJs).toContain("window.prompt('Reason note for submitting this blocked input'");
    expect(clientJs).toContain('reason_note: reasonNote');
    expect(clientJs).toContain('Resume skipped: reason note is required');
    expect(clientJs).toContain('Input submit skipped: reason note is required');
  });

  it('renders blocked root cause before the current operator latch reason', () => {
    const clientJs = renderDashboardClientJs();
    const rootCauseIndex = clientJs.indexOf('function createBlockedRootCauseBlock(entry)');
    const currentBlockIndex = clientJs.indexOf('Current operator block: ');

    expect(clientJs).toContain('Workspace provisioning failed: repo root has uncommitted or untracked files.');
    expect(clientJs).toContain('Remediation: ');
    expect(clientJs).toContain('Current block detail: ');
    expect(clientJs).toContain('root-cause-block');
    expect(rootCauseIndex).toBeGreaterThanOrEqual(0);
    expect(currentBlockIndex).toBeGreaterThan(rootCauseIndex);
  });
});
