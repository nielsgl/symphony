import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { renderDashboardClientJs, renderDashboardHtml } from '../../src/api/dashboard-assets';

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
  disabled = false;
  href = '';
  id = '';
  open = true;
  placeholder = '';
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
    const handlers = this.listeners.get('click') || [];
    for (const handler of handlers) {
      handler({ target: this, preventDefault() {} });
    }
  }

  focus(): void {
    // Focus tracking is not needed for these dashboard assertions.
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) || null;
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

  querySelectorAll(_selector: string): FakeElement[] {
    return [];
  }

  addEventListener(type: string, handler: (event: { key?: string; preventDefault(): void }) => void): void {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
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
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function createRuntimeStatePayload() {
  return {
    generated_at: '2026-05-08T16:00:00.000Z',
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
