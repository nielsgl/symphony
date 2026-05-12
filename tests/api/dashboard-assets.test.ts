import vm from 'node:vm';

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
  private readonly values = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) {
      this.values.add(token);
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      this.values.delete(token);
    }
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }

  toggle(token: string, force?: boolean): boolean {
    const shouldAdd = force ?? !this.values.has(token);
    if (shouldAdd) {
      this.values.add(token);
      return true;
    }
    this.values.delete(token);
    return false;
  }

  setFromClassName(className: string): void {
    this.values.clear();
    for (const token of className.split(/\s+/)) {
      if (token) {
        this.values.add(token);
      }
    }
  }

  toString(): string {
    return Array.from(this.values).join(' ');
  }
}

class FakeElement {
  readonly tagName: string;
  readonly classList = new FakeClassList();
  readonly listeners = new Map<string, Array<(event: { target?: FakeElement; key?: string; preventDefault(): void }) => void>>();
  readonly attributes = new Map<string, string>();
  children: FakeElement[] = [];
  colSpan = 0;
  dataset: Record<string, string> = {};
  disabled = false;
  href = '';
  id = '';
  open = true;
  placeholder = '';
  style: Record<string, string> = {};
  title = '';
  type = '';
  value = '';
  private ownText = '';
  private ownClassName = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get className(): string {
    return this.ownClassName;
  }

  set className(value: string) {
    this.ownClassName = value;
    this.classList.setFromClassName(value);
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      this.appendChild(typeof node === 'string' ? FakeElement.text(node) : node);
    }
  }

  appendChild(node: FakeElement): FakeElement {
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.ownText = '';
    this.children = nodes;
  }

  addEventListener(type: string, handler: (event: { target?: FakeElement; key?: string; preventDefault(): void }) => void): void {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  click(): void {
    this.dispatch('click');
  }

  dispatch(type: string, event: { target?: FakeElement; key?: string; preventDefault(): void } = { preventDefault() {} }): void {
    const handlers = type === 'click' ? this.listeners.get('click') || [] : this.listeners.get(type) || [];
    for (const handler of handlers) {
      handler({ ...event, target: event.target ?? this });
    }
  }

  focus(): void {
    // Focus tracking is not needed for these dashboard assertions.
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name.startsWith('data-')) {
      this.dataset[name.slice('data-'.length)] = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name.startsWith('data-')) {
      return this.dataset[name.slice('data-'.length)] || null;
    }
    return this.attributes.get(name) || null;
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return [];
  }

  static text(value: string): FakeElement {
    const element = new FakeElement('#text');
    element.textContent = value;
    return element;
  }
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>();
  readonly listeners = new Map<string, Array<(event: { key?: string; preventDefault(): void }) => void>>();
  activeElement: FakeElement | null = null;

  constructor(html: string) {
    const ids = html.matchAll(/id="([^"]+)"/g);
    for (const match of ids) {
      const element = new FakeElement('div');
      element.id = match[1];
      this.elements.set(match[1], element);
    }
  }

  getElementById(id: string): FakeElement {
    let element = this.elements.get(id);
    if (!element) {
      element = new FakeElement('div');
      element.id = id;
      this.elements.set(id, element);
    }
    return element;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  createTextNode(value: string): FakeElement {
    return FakeElement.text(value);
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return [];
  }

  addEventListener(type: string, handler: (event: { key?: string; preventDefault(): void }) => void): void {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<(event: { data: string }) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  addEventListener(type: string, handler: (event: { data: string }) => void) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(handler);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: { data: string }) {
    for (const handler of this.listeners.get(type) || []) {
      handler(event);
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function okJson(payload: unknown) {
  return {
    ok: true,
    async json() {
      return payload;
    }
  };
}

async function flushPromises(): Promise<void> {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
  }
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
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
    health: {
      dispatch_validation: 'ok',
      last_error: null
    },
    rate_limits: null,
    throughput: null,
    running: [],
    retrying: [],
    blocked: [],
    stopped_runs: [],
    recent_events: [],
    recent_runtime_events: []
  };
}

function createRuntimeStatePayload() {
  return makeStatePayload();
}

function createStoppedRunRecoveryPayload() {
  return {
    counts: {
      stopped: 1
    },
    stopped_runs: [
      {
        run_id: 'run-stopped-1',
        issue_identifier: 'NIE-119',
        thread_id: 'thread-stopped-1',
        session_id: 'session-stopped-1',
        turn_id: 'turn-stopped-1',
        last_relevant_at: '2026-05-08T15:59:00.000Z',
        terminal_status: 'stopped',
        terminal_reason_code: 'capability_mismatch',
        terminal_reason_detail: 'Stopped after unsupported browser capability.',
        root_cause_status: 'action_required',
        root_cause_reason_code: 'missing_tool_output_recovery',
        root_cause_reason_detail: 'Inspect thread lineage before resume.',
        recovery_status: 'capability_mismatch',
        capability_mismatch: true,
        resume_valid: false,
        resume_disabled_reason: 'Unsupported browser capability.',
        capability_warning: {
          unsupported_capability_message: 'Browser tool was unavailable.',
          recommended_recovery_action: 'Resume with browser-capable runtime.'
        },
        actions: {
          inspect_forensics_url: '/api/v1/history/run-stopped-1',
          inspect_thread_url: '/api/v1/threads/thread-stopped-1',
          copy_thread_id_supported: true,
          copy_session_id_supported: true
        }
      }
    ]
  };
}

function installDashboardClient(fetchImpl: (url: string, init?: unknown) => Promise<{ ok: boolean; json(): Promise<unknown> }>) {
  const document = new FakeDocument(renderDashboardHtml());
  const storage = new Map<string, string>();
  const fetchCalls: string[] = [];
  const sandbox = {
    console,
    document,
    EventSource: class {
      close() {}
    },
    fetch: (url: string, init?: unknown) => {
      fetchCalls.push(String(url));
      return fetchImpl(String(url), init);
    },
    localStorage: {
      getItem(key: string) {
        return storage.get(key) || null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      }
    },
    setInterval() {
      return 0;
    },
    clearInterval() {},
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    window: {
      confirm: () => true,
      localStorage: {
        getItem(key: string) {
          return storage.get(key) || null;
        },
        setItem(key: string, value: string) {
          storage.set(key, value);
        }
      },
      open() {},
      prompt: () => ''
    }
  };
  sandbox.window = { ...sandbox.window, localStorage: sandbox.localStorage };
  vm.runInNewContext(
    renderDashboardClientJs({
      dashboard_enabled: false,
      refresh_ms: 500,
      render_interval_ms: 250
    }),
    sandbox
  );

  return { document, fetchCalls };
}

function installDashboardClientHarness(options: { stateError?: Error } = {}) {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  const document = new FakeDocument(renderDashboardHtml());
  const fetchCalls: string[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    fetchCalls.push(String(url));
    if (url === '/api/v1/state') {
      if (options.stateError) {
        return Promise.reject(options.stateError);
      }
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
    },
    prompt: vi.fn(() => ''),
    confirm: vi.fn(() => true)
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', FakeEventSource);

  const script = renderDashboardClientJs({ dashboard_enabled: true, refresh_ms: 500, render_interval_ms: 500, phase_stale_warn_ms: 1000 });
  Function(script)();

  return {
    document,
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
    expect(clientJs).toContain('phase unchanged for ');
    expect(clientJs).toContain('Codex thread active ');
    expect(clientJs).toContain('Codex thread activity unavailable');
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
    expect(harness.document.getElementById('connection-badge').textContent).toBe('Connecting');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('SSE connected; waiting for first state_snapshot');
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();

    expect(harness.stateFetchCount()).toBe(2);
    expect(harness.document.getElementById('connection-badge').textContent).toBe('Polling');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('SSE connected; waiting for first state_snapshot');
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
    expect(harness.document.getElementById('connection-badge').textContent).toBe('Streaming');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('SSE streaming live state_snapshot updates');
  });

  it('handles named symphony SSE events from the server', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    harness.stream().onopen?.();
    harness.stream().emit('symphony', {
      data: JSON.stringify({ type: 'state_snapshot', payload: { state: makeStatePayload() } })
    });
    await flushPromises();

    expect(harness.document.getElementById('connection-badge').textContent).toBe('Streaming');
    expect(harness.stateFetchCount()).toBe(1);
  });

  it('renders polling fallback live instead of offline when polling succeeds while SSE is unhealthy', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    harness.stream().onerror?.();
    await flushPromises();

    expect(harness.stateFetchCount()).toBe(2);
    expect(harness.document.getElementById('connection-badge').textContent).toBe('Polling');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('SSE disconnected after stream error; polling fallback live');
    expect(harness.document.getElementById('connection-badge').textContent).not.toBe('Offline');
  });

  it('renders offline only when polling fails', async () => {
    const harness = installDashboardClientHarness({ stateError: new Error('api unavailable') });
    await flushPromises();

    expect(harness.document.getElementById('connection-badge').textContent).toBe('Offline');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('Polling failed');
  });

  it('renders overdue retry causes above the retry table', async () => {
    const harness = installDashboardClientHarness();
    vi.setSystemTime(new Date('2026-05-11T13:05:21.648Z'));
    await flushPromises();

    const state = makeStatePayload() as any;
    state.counts.retrying = 1;
    state.retry_status = {
      total: 1,
      overdue_count: 1,
      pending_count: 0,
      entries: [
        {
          issue_id: 'issue-nie-128',
          issue_identifier: 'NIE-128',
          attempt: 1,
          due_at: '2026-05-11T12:56:21.648Z',
          due_at_ms: Date.parse('2026-05-11T12:56:21.648Z'),
          due_state: 'overdue',
          overdue_ms: 540000,
          retry_wait_ms: null,
          reason_code: 'issue_state_refresh_failed',
          detail: 'issue_state_refresh_failed: Linear request failed: TypeError: fetch failed',
          operator_detail:
            'The Codex turn completed and reached post-run tracker refresh, but Symphony could not refresh the issue state from Linear before deciding the next workflow step. The scheduled retry refreshes tracker state without rerunning the completed turn.',
          headline: 'Tracker refresh failed after run activity',
          expected_transition: 'Retry due time passed 540000ms ago; dispatch may be stuck',
          last_phase: 'validation'
        }
      ]
    };
    state.retrying = [
      {
        issue_identifier: 'NIE-128',
        attempt: 1,
        due_at: '2026-05-11T12:56:21.648Z',
        due_state: 'overdue',
        overdue_ms: 540000,
        retry_wait_ms: null,
        stop_reason_code: 'issue_state_refresh_failed',
        stop_reason_detail: 'issue_state_refresh_failed: Linear request failed: TypeError: fetch failed',
        error: 'issue_state_refresh_failed: Linear request failed: TypeError: fetch failed',
        worker_host: 'hessian',
        workspace_path: '/tmp/symphony/NIE-128',
        provisioner_type: 'worktree',
        workspace_provisioned: true,
        workspace_is_git_worktree: true,
        last_phase: 'validation',
        operator_explainer_hint: {
          classification: 'retrying',
          actionability: 'recommended',
          headline: 'Tracker refresh failed after run activity'
        },
        retry_cause: state.retry_status.entries[0]
      }
    ];

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state } })
    });
    await flushPromises();

    const overviewText = harness.document.getElementById('retry-status-summary').textContent;
    expect(overviewText).toContain('1 overdue retry needs attention');
    expect(overviewText).toContain('NIE-128');
    expect(overviewText).toContain('issue_state_refresh_failed');
    expect(overviewText).toContain('post-run tracker refresh');
    expect(overviewText).toContain('Overdue 9m 0s');
    expect(overviewText).toContain('Last phase: validation');
  });

  it('labels successful polling fallback as polling instead of offline', async () => {
    const harness = installDashboardClientHarness();
    await flushPromises();

    expect(harness.document.getElementById('connection-badge').textContent).toBe('Polling');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('SSE connecting; polling fallback live');
  });

  it('renders phase age and Codex thread activity as separate clocks', async () => {
    const harness = installDashboardClientHarness();
    vi.setSystemTime(new Date('2026-05-08T15:05:00.000Z'));
    await flushPromises();

    const state = makeStatePayload() as any;
    state.counts.running = 1;
    state.running = [
      {
        issue_identifier: 'NIE-78',
        state: 'In Progress',
        session_id: 'thread-1-turn-1',
        worker_host: 'hessian',
        workspace_path: '/tmp/symphony/NIE-78',
        provisioner_type: 'worktree',
        branch_name: 'feature/NIE-78',
        workspace_git_status: 'clean',
        thread_id: 'thread-1',
        turn_id: 'turn-1',
        turn_count: 1,
        current_phase: 'implementation',
        current_phase_at: '2026-05-08T15:00:00.000Z',
        phase_elapsed_ms: 300000,
        phase_timing: {
          phase_started_at: '2026-05-08T15:00:00.000Z',
          phase_elapsed_ms: 300000,
          source: 'symphony_phase_marker'
        },
        codex_thread_activity: {
          thread_id: 'thread-1',
          updated_at: '2026-05-08T15:04:45.000Z',
          updated_at_ms: Date.parse('2026-05-08T15:04:45.000Z'),
          age_ms: 15000,
          source: 'app_server_protocol_thread_updated_at',
          status: 'available',
          thread_status: 'running'
        },
        started_at: '2026-05-08T14:55:00.000Z',
        last_event: 'codex.turn.waiting',
        last_event_summary: 'codex turn waiting: heartbeat',
        last_message: 'heartbeat',
        last_event_at: '2026-05-08T15:04:30.000Z',
        tokens: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        token_telemetry_status: 'available',
        token_telemetry_confidence: 'observed_live',
        token_telemetry_source: 'app_server_protocol',
        turn_control_state: 'agent_turn',
        progress_signal_state: 'heartbeat_only',
        current_blocker_class: null,
        time_since_progress: 300000,
        last_successful_step: 'codex.turn.started',
        transcript_tool_call_diagnostic_summary: null,
        operator_actions: [],
        actions: {}
      }
    ];

    harness.stream().onopen?.();
    harness.stream().onmessage?.({
      data: JSON.stringify({ type: 'state_snapshot', payload: { state } })
    });
    await flushPromises();

    const text = harness.document.getElementById('running-rows').textContent;
    expect(text).toContain('implementation');
    expect(text).toContain('phase unchanged for 5m');
    expect(text).not.toContain('updated 5m ago');
    expect(text).toContain('Codex thread active 0m 15s ago');
    expect(text).toContain('codex turn waiting: heartbeat');
    expect(text).toContain('5:04:30');
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
    expect(harness.document.getElementById('connection-badge').textContent).toBe('Polling');
    expect(harness.document.getElementById('connection-detail').textContent).toBe('SSE disconnected after stream error; polling fallback live');

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

    harness.document.getElementById('refresh-button').click();
    await flushPromises();

    expect(harness.refreshFetchCount()).toBe(1);
    expect(harness.stateFetchCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();
    expect(harness.stateFetchCount()).toBe(2);
  });

  it('lazy-loads stopped-run recovery details only on operator request', () => {
    const html = renderDashboardHtml();
    const clientJs = renderDashboardClientJs();
    const pollBlock = clientJs.slice(clientJs.indexOf('async function loadStateViaPoll()'), clientJs.indexOf('function scheduleStateSave()'));
    const streamBlock = clientJs.slice(clientJs.indexOf('function handleSseEnvelope'), clientJs.indexOf('function connectStream'));

    expect(html).toContain('id="stopped-run-recovery-load"');
    expect(clientJs).toContain("fetchJson('/api/v1/stopped-runs/recovery')");
    expect(clientJs).toContain("elements.stoppedRunRecoveryLoad.addEventListener('click'");
    expect(clientJs).toContain('Stopped-run recovery detail loads on demand.');
    expect(pollBlock).not.toContain('/api/v1/stopped-runs/recovery');
    expect(streamBlock).not.toContain('/api/v1/stopped-runs/recovery');
  });

  it('preserves stopped-run recovery loaded before the initial state snapshot', async () => {
    const stateRequest = deferred<{ ok: boolean; json(): Promise<unknown> }>();
    const fetchCalls: string[] = [];
    const runtime = installDashboardClient(async (url) => {
      fetchCalls.push(url);
      if (url === '/api/v1/state') {
        return stateRequest.promise;
      }
      if (url === '/api/v1/stopped-runs/recovery') {
        return okJson(createStoppedRunRecoveryPayload());
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
      throw new Error('Unexpected dashboard fetch: ' + url);
    });

    await flushPromises();

    expect(fetchCalls).toContain('/api/v1/state');
    expect(fetchCalls).not.toContain('/api/v1/stopped-runs/recovery');

    const recoveryList = runtime.document.getElementById('stopped-run-recovery-list');
    runtime.document.getElementById('stopped-run-recovery-load').click();
    await flushPromises();

    expect(fetchCalls.filter((url) => url === '/api/v1/stopped-runs/recovery')).toHaveLength(1);
    expect(recoveryList.textContent).toContain('NIE-119');
    expect(recoveryList.textContent).toContain('Capability mismatch');
    expect(recoveryList.textContent).toContain('Browser tool was unavailable.');

    stateRequest.resolve(okJson(createRuntimeStatePayload()));
    await flushPromises();

    expect(recoveryList.textContent).toContain('NIE-119');
    expect(recoveryList.textContent).toContain('Capability mismatch');
    expect(recoveryList.textContent).toContain('Browser tool was unavailable.');
    expect(recoveryList.textContent).not.toContain('No recent stopped runs need recovery.');
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

  it('renders distinct operator copy and safe actions for stalled waiting recovery states', () => {
    const clientJs = renderDashboardClientJs();

    expect(clientJs).toContain("return 'Heartbeat Only'");
    expect(clientJs).toContain("return 'Stalled Waiting'");
    expect(clientJs).toContain("return 'Retry Scheduled'");
    expect(clientJs).toContain("return 'Manual Resume Required'");
    expect(clientJs).toContain("createActionButton('Inspect Diagnostics'");
    expect(clientJs).toContain("createActionButton('Cancel Turn'");
    expect(clientJs).toContain("createActionButton('Requeue'");
    expect(clientJs).not.toContain("createActionButton('Cleanup Workspace'");
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
