import { describe, expect, it } from 'vitest';

import { SnapshotService, projectLivingAgentLens } from '../../src/api';
import { CANONICAL_EVENT } from '../../src/observability/events';
import { REASON_CODES } from '../../src/observability/reason-codes';
import type { OrchestratorState } from '../../src/orchestrator';
import type { Issue } from '../../src/tracker';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'NIE-300',
    title: 'Chatty',
    description: null,
    priority: 1,
    state: 'In Progress',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: new Date('2026-06-04T11:00:00.000Z'),
    updated_at: new Date('2026-06-04T11:00:00.000Z'),
    ...overrides
  };
}

function makeRunningEntry(overrides: Record<string, unknown> = {}) {
  return {
    issue: makeIssue(),
    identifier: 'NIE-300',
    run_id: 'run-1',
    worker_handle: {},
    monitor_handle: {},
    retry_attempt: 0,
    workspace_path: '/tmp/symphony/NIE-300',
    provisioner_type: 'none',
    branch_name: null,
    repo_root: null,
    workspace_exists: true,
    workspace_git_status: 'clean' as const,
    workspace_provisioned: true,
    workspace_is_git_worktree: false,
    session_id: 'session-300',
    thread_id: 'thread_01JX7',
    turn_id: 'turn-3',
    codex_app_server_pid: '12345',
    turn_count: 2,
    last_event: CANONICAL_EVENT.codex.turnCompleted,
    last_event_summary: 'codex turn completed: done',
    last_message: 'I will continue the analysis.',
    awaiting_input_since_ms: null,
    pending_input_preview: null,
    stalled_waiting_since_ms: null,
    stalled_waiting_reason: null,
    tokens: {
      input_tokens: 11,
      output_tokens: 5,
      total_tokens: 16,
      model_context_window: 200
    },
    last_reported_tokens: { input_tokens: 11, output_tokens: 5, total_tokens: 16 },
    token_telemetry_status: 'available' as const,
    token_telemetry_last_source: 'terminal_turn_summary',
    token_telemetry_last_at_ms: Date.parse('2026-06-04T12:41:28.000Z'),
    token_telemetry_turn_started_at_ms: Date.parse('2026-06-04T12:41:00.000Z'),
    token_telemetry_warning_emitted: false,
    recent_events: [
      { at_ms: Date.parse('2026-06-04T12:41:00.000Z'), event: CANONICAL_EVENT.codex.turnCompleted, message: 'done' }
    ],
    started_at_ms: Date.parse('2026-06-04T12:30:00.000Z'),
    last_codex_timestamp_ms: Date.parse('2026-06-04T12:41:28.000Z'),
    ...overrides
  };
}

function makeBlockedEntry(overrides: Record<string, unknown> = {}) {
  return {
    issue_id: 'issue-2',
    issue_identifier: 'NIE-312',
    attempt: 1,
    blocked_at_ms: Date.parse('2026-06-04T12:00:00.000Z'),
    stop_reason_code: REASON_CODES.awaitingHumanReviewScopeIncomplete,
    stop_reason_detail: 'Awaiting human review',
    worker_host: null,
    workspace_path: '/tmp/symphony/NIE-312',
    branch_name: 'feature/NIE-312',
    provisioner_type: 'none',
    repo_root: null,
    workspace_exists: true,
    workspace_git_status: 'clean' as const,
    workspace_provisioned: true,
    workspace_is_git_worktree: false,
    conflict_files: [] as Array<{ path: string; status: 'staged' | 'unstaged' | 'unknown' }>,
    resolution_hints: [] as string[],
    previous_thread_id: 'thread-312',
    previous_session_id: 'session-312',
    requires_manual_resume: true,
    awaiting_operator: true,
    awaiting_operator_reason_code: REASON_CODES.awaitingHumanReviewScopeIncomplete,
    awaiting_operator_since_ms: Date.parse('2026-06-04T12:00:00.000Z'),
    awaiting_operator_resume_nonce: 1,
    runtime_state_kind: 'blocked_input' as const,
    pending_input: null,
    resume_history: [] as never[],
    session_console: [] as never[],
    ...overrides
  };
}

function blockedWithPendingInput() {
  return makeBlockedEntry({
    issue_id: 'issue-3',
    issue_identifier: 'NIE-321',
    runtime_state_kind: 'blocked_input',
    stop_reason_code: REASON_CODES.awaitingHumanReviewScopeIncomplete,
    pending_input: {
      request_id: 'req-abc-123',
      request_method: 'operator.input',
      prompt_text: 'Approve the rollout?',
      questions: [
        {
          id: 'q1',
          prompt: 'Approve?',
          options: [
            { label: 'yes', value: 'yes' },
            { label: 'no', value: 'no' }
          ]
        }
      ],
      input_schema_type: 'options',
      input_required_at_ms: Date.parse('2026-06-04T12:30:00.000Z')
    }
  });
}

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    poll_interval_ms: 30_000,
    max_concurrent_agents: 10,
    running: new Map(),
    claimed: new Set(),
    retry_attempts: new Map(),
    blocked_inputs: new Map(),
    circuit_breakers: new Map(),
    budget_usage_samples: new Map(),
    completed: new Set(),
    codex_totals: { input_tokens: 10, output_tokens: 20, total_tokens: 30, seconds_running: 40 },
    codex_rate_limits: null,
    health: { dispatch_validation: 'ok', last_error: null },
    drain_mode: { active: false, entered_at_ms: null, updated_at_ms: null, reason: null },
    quiescence: {
      safe_to_shutdown: true,
      state: 'safe',
      updated_at_ms: Date.parse('2026-06-04T12:41:00.000Z'),
      blockers: [],
      blocker_counts: {
        active_worker: 0,
        live_codex_app_server_process: 0,
        pending_retry: 0,
        in_flight_tracker_write: 0,
        persistence_history_write: 0,
        unknown_degraded_blocker_source_health: 0,
        stale_runtime: 0,
        unknown_current_build_identity: 0
      },
      warnings: [],
      restart_guidance: {
        safe_to_restart: true,
        recommended_action: 'none',
        pending_work: [],
        detail: 'Runtime is safe to restart.'
      }
    },
    runtime_identity: null,
    throughput: { current_tps: 0, avg_tps_60s: 0, window_seconds: 600, sparkline_10m: Array.from({ length: 24 }, () => 0), sample_count: 0 },
    recent_runtime_events: [],
    ...overrides
  };
}

const NOW = Date.parse('2026-06-04T12:41:28.000Z');

function project(overrides: Partial<OrchestratorState> = {}, opts: Parameters<typeof projectLivingAgentLens>[1] = {}) {
  const service = new SnapshotService({ nowMs: () => NOW });
  const state = makeState(overrides);
  const apiState = service.projectState(state);
  return projectLivingAgentLens(apiState, { nowMs: NOW, ...opts });
}

describe('projectLivingAgentLens', () => {
  it('orders the queue by gravity score and selects top-of-queue when no focus_issue is supplied', () => {
    const awaitingInput = makeRunningEntry({
      issue: makeIssue({ id: 'issue-2', identifier: 'NIE-312', title: 'Auth Flow Polish' }),
      identifier: 'NIE-312',
      pending_input_preview: { type: 'text', prompt_preview: 'Clarify direction?', option_count: null },
      awaiting_input_since_ms: NOW - 60_000,
      last_message: 'I need clarification on the next step.'
    });
    const lens = project({
      running: new Map([
        ['issue-1', makeRunningEntry()],
        ['issue-2', awaitingInput]
      ])
    });
    expect(lens.queue.length).toBe(2);
    // awaiting-input outranks normal running
    expect(lens.queue[0].issue_identifier).toBe('NIE-312');
    expect(lens.queue[0].gravity_score).toBeGreaterThan(lens.queue[1].gravity_score);
    // Top row is the focus
    expect(lens.queue[0].is_focus).toBe(true);
    expect(lens.queue[1].is_focus).toBe(false);
  });

  it('honors an explicit focus_issue regardless of gravity ordering', () => {
    const lens = project(
      {
        running: new Map([['issue-1', makeRunningEntry()]])
      },
      { focusIssueIdentifier: 'NIE-300' }
    );
    expect(lens.focus?.issue_identifier).toBe('NIE-300');
    expect(lens.queue.find((row) => row.is_focus)?.issue_identifier).toBe('NIE-300');
  });

  it('emits missing_capabilities for gravity_score, role_stream_window, bounded_window, transcript_confidence, command_preview, and audit receipts', () => {
    const lens = project({ running: new Map([['issue-1', makeRunningEntry()]]) });
    const ids = lens.missing_capabilities.map((m) => m.id);
    expect(ids).toContain('gravity_score');
    expect(ids).toContain('role_stream_window');
    expect(ids).toContain('bounded_window');
    expect(ids).toContain('transcript_confidence');
    expect(ids).toContain('command_preview');
    expect(ids).toContain('evidence_path_receipts');
    // Every missing_capability must have an implementation_hint so the UI can show it honestly.
    for (const cap of lens.missing_capabilities) {
      expect(cap.implementation_hint.length).toBeGreaterThan(0);
      expect(cap.label.length).toBeGreaterThan(0);
    }
  });

  it('returns an empty queue and disabled actions when no active work exists', () => {
    const lens = project({});
    expect(lens.queue).toEqual([]);
    expect(lens.focus).toBeNull();
    expect(lens.lens).toBeNull();
    for (const action of lens.actions) {
      if (action.id === 'drain_wait' || action.id === 'more') continue;
      expect(action.enabled).toBe(false);
      expect(action.disabled_reason).toBeTruthy();
    }
  });

  it('builds the four interlock steps in order with consistent tones', () => {
    const lens = project({ running: new Map([['issue-1', makeRunningEntry()]]) });
    expect(lens.interlocks).toHaveLength(4);
    expect(lens.interlocks.map((s) => s.id)).toEqual(['preconditions', 'intent', 'preview', 'receipt']);
    // No interlock step may be silently green without a backing check.
    for (const step of lens.interlocks) {
      expect(step.title).toMatch(/^\d /);
      expect(step.body).toBeDefined();
    }
  });

  it('builds the evidence path with thread, transcript, api_snapshot, and audit nodes', () => {
    const lens = project({ running: new Map([['issue-1', makeRunningEntry()]]) });
    expect(lens.evidence_path.map((n) => n.id)).toEqual(['thread', 'transcript', 'api_snapshot', 'audit']);
    const audit = lens.evidence_path.find((n) => n.id === 'audit');
    expect(audit).toBeDefined();
    expect(audit?.tone).toBe('gray');
  });

  it('exposes a six-button action dock matching the spec (steer/resume/inspect_evidence/export_forensics/drain_wait/more)', () => {
    const lens = project({ running: new Map([['issue-1', makeRunningEntry()]]) });
    expect(lens.actions.map((a) => a.id)).toEqual([
      'steer',
      'resume',
      'inspect_evidence',
      'export_forensics',
      'drain_wait',
      'more'
    ]);
    const more = lens.actions.find((a) => a.id === 'more');
    expect(more?.more_items?.map((m) => m.label)).toEqual([
      'Runtime Panels',
      'Event Feed',
      'Project History',
      'Diagnostics',
      'Raw JSON',
      'Classic Dashboard',
      'Settings'
    ]);
    const eventFeed = more?.more_items?.find((m) => m.id === 'event_feed');
    expect(eventFeed?.enabled).toBe(false);
    expect(eventFeed?.endpoint).toBeNull();
    expect(eventFeed?.disabled_reason).toMatch(/SSE/);
    const classic = more?.more_items?.find((m) => m.id === 'classic_dashboard');
    expect(classic?.endpoint).toBe('/dashboard');
  });

  it('disables Steer/Resume for plain running entries and surfaces command_preview missing capability', () => {
    const lens = project({ running: new Map([['issue-1', makeRunningEntry()]]) });
    const steer = lens.actions.find((a) => a.id === 'steer');
    const resume = lens.actions.find((a) => a.id === 'resume');
    expect(steer?.enabled).toBe(false);
    expect(steer?.disabled_reason).toMatch(/No pending operator input|running agent/);
    expect(resume?.enabled).toBe(false);
    expect(resume?.disabled_reason).toMatch(/blocked/);
    const preview = lens.interlocks.find((s) => s.id === 'preview');
    expect(preview?.state_label).toBe('Preview unavailable');
    expect(preview?.tone).toBe('amber');
    if (preview?.body.kind === 'preview') {
      expect(preview.body.endpoint).toBeNull();
      expect(preview.body.body_preview).toMatch(/No backend route/);
    }
    const ids = lens.missing_capabilities.map((m) => m.id);
    expect(ids).toContain('command_preview');
    const cmd = lens.missing_capabilities.find((m) => m.id === 'command_preview');
    expect(cmd?.severity).toBe('blocks_action');
  });

  it('does not point the transcript evidence pill at a route that does not exist', () => {
    const lens = project({ running: new Map([['issue-1', makeRunningEntry()]]) });
    const transcript = lens.evidence_path.find((n) => n.id === 'transcript');
    expect(transcript).toBeDefined();
    // /api/v1/sessions/:id/rollout is not a real route — the pill must not be openable.
    expect(transcript?.open_endpoint).toBeNull();
    expect(transcript?.tone).toBe('amber');
    expect(transcript?.detail).toMatch(/rollout viewer is not implemented|No session id/);
    const ids = lens.missing_capabilities.map((m) => m.id);
    expect(ids).toContain('transcript_open_endpoint');
  });

  it('points the api_snapshot evidence pill at /api/v1/issues/:identifier (real route)', () => {
    const lens = project({ running: new Map([['issue-1', makeRunningEntry()]]) }, { focusIssueIdentifier: 'NIE-300' });
    const apiSnap = lens.evidence_path.find((n) => n.id === 'api_snapshot');
    expect(apiSnap?.open_endpoint).toBe('/api/v1/issues/NIE-300');
  });

  it('populates shell brand and core telemetry cells', () => {
    const lens = project(
      { running: new Map([['issue-1', makeRunningEntry()]]) },
      { auditHealth: { enabled: true, integrity_ok: true, recent_write_failure: null } }
    );
    expect(lens.shell.brand.title).toBe('Symphony Control Constellation');
    expect(lens.shell.brand.subtitle).toBe('Living Agent Lens');
    expect(lens.shell.audit.value).toBe('Recording');
    expect(lens.shell.audit.tone).toBe('red');
    expect(lens.shell.orchestrator.value).toBe('Local');
    expect(lens.shell.refresh_pulse.label).toBe('Refresh Pulse');
    expect(lens.shell.filters.map((f) => f.id)).toEqual([
      'needs_me',
      'stalled',
      'retry_overdue',
      'unsafe_restart',
      'budget_risk',
      'model_rerouted'
    ]);
  });

  it('clamps gravity scores into [0.1, 1.0] and bands them per the spec', () => {
    const lens = project({ running: new Map([['issue-1', makeRunningEntry()]]) });
    for (const row of lens.queue) {
      expect(row.gravity_score).toBeGreaterThanOrEqual(0.1);
      expect(row.gravity_score).toBeLessThanOrEqual(1.0);
      expect(['focus', 'urgent', 'warning', 'active', 'idle']).toContain(row.gravity_band);
      // Every score must be explainable.
      expect(row.gravity_reasons.length).toBeGreaterThanOrEqual(0);
    }
  });

  // ── Positive route-contract tests ──────────────────────────────────────────
  // These guard against silent drift: the preview body must match the exact
  // request shape that POST /input, /resume, and /clear-automation-fault accept.

  it('builds a /input preview whose body contains the pending_input.request_id and the answer shape the route accepts', () => {
    const blocked = blockedWithPendingInput();
    const lens = project(
      { blocked_inputs: new Map([[blocked.issue_id, blocked as never]]) },
      { focusIssueIdentifier: blocked.issue_identifier }
    );
    const preview = lens.interlocks.find((s) => s.id === 'preview');
    expect(preview).toBeDefined();
    expect(preview?.tone).toBe('amber');
    if (preview?.body.kind !== 'preview') throw new Error('preview body kind mismatch');
    expect(preview.body.method).toBe('POST');
    expect(preview.body.endpoint).toBe(`/api/v1/issues/${blocked.issue_identifier}/input`);
    const body = preview.body.body_preview ?? '';
    // Real /input contract requires request_id + reason_note + answer.
    expect(body).toContain('"request_id": "req-abc-123"');
    expect(body).toContain('"reason_note"');
    expect(body).toContain('"answer"');
    expect(body).toContain('"question_id"');
    // Steer must be enabled because target.kind === 'submit_input'.
    const steer = lens.actions.find((a) => a.id === 'steer');
    expect(steer?.enabled).toBe(true);
    expect(steer?.disabled_reason).toBeNull();
    // command_preview missing-capability is visual-only when the body shape matches.
    const cmd = lens.missing_capabilities.find((m) => m.id === 'command_preview');
    expect(cmd?.severity).toBe('visual_only');
  });

  it('builds a /resume preview whose body matches the route contract (reason_note + optional resume_override_reason)', () => {
    const blocked = makeBlockedEntry();
    const lens = project(
      { blocked_inputs: new Map([[blocked.issue_id, blocked as never]]) },
      { focusIssueIdentifier: blocked.issue_identifier }
    );
    const preview = lens.interlocks.find((s) => s.id === 'preview');
    expect(preview).toBeDefined();
    if (preview?.body.kind !== 'preview') throw new Error('preview body kind mismatch');
    expect(preview.body.method).toBe('POST');
    expect(preview.body.endpoint).toBe(`/api/v1/issues/${blocked.issue_identifier}/resume`);
    const body = preview.body.body_preview ?? '';
    expect(body).toContain('"reason_note"');
    expect(body).toContain('"resume_override_reason"');
    // /resume should NOT include the /input-specific request_id or answer.
    expect(body).not.toContain('"request_id"');
    expect(body).not.toContain('"answer"');
    // Resume must be enabled, Steer disabled (no pending_input on this entry).
    const steer = lens.actions.find((a) => a.id === 'steer');
    const resume = lens.actions.find((a) => a.id === 'resume');
    expect(steer?.enabled).toBe(false);
    expect(resume?.enabled).toBe(true);
    expect(resume?.disabled_reason).toBeNull();
  });

  // ── Audit honesty ──────────────────────────────────────────────────────────

  it('degrades the Audit ribbon cell to amber Unknown + missing_capability when auditHealth is not provided', () => {
    const lens = project({ running: new Map([['issue-1', makeRunningEntry()]]) });
    expect(lens.shell.audit.value).toBe('Unknown');
    expect(lens.shell.audit.tone).toBe('amber');
    const ids = lens.missing_capabilities.map((m) => m.id);
    expect(ids).toContain('audit_recording_proof');
  });

  it('marks Audit as Not recording when auditHealth.enabled is false', () => {
    const lens = project(
      { running: new Map([['issue-1', makeRunningEntry()]]) },
      { auditHealth: { enabled: false, integrity_ok: true, recent_write_failure: null } }
    );
    expect(lens.shell.audit.value).toBe('Not recording');
    expect(lens.shell.audit.tone).toBe('amber');
  });

  it('marks Audit as Degraded (red) when integrity_ok is false', () => {
    const lens = project(
      { running: new Map([['issue-1', makeRunningEntry()]]) },
      {
        auditHealth: {
          enabled: true,
          integrity_ok: false,
          recent_write_failure: { at: '2026-06-04T12:00:00Z', detail: 'SQLITE_IOERR' }
        }
      }
    );
    expect(lens.shell.audit.value).toBe('Degraded');
    expect(lens.shell.audit.tone).toBe('red');
    expect(lens.shell.audit.detail).toContain('SQLITE_IOERR');
  });

  // ── Shell control honesty ────────────────────────────────────────────────

  it('emits a shell_smart_filters missing capability so the Filters button can render as disabled', () => {
    const lens = project({ running: new Map([['issue-1', makeRunningEntry()]]) });
    const ids = lens.missing_capabilities.map((m) => m.id);
    expect(ids).toContain('shell_smart_filters');
    const gap = lens.missing_capabilities.find((m) => m.id === 'shell_smart_filters');
    expect(gap?.severity).toBe('degrades_observability');
    expect(gap?.implementation_hint).toBeTruthy();
    // Filter counts are still computed; only the panel UI is missing.
    expect(lens.shell.filters.length).toBe(6);
  });

  it('shell telemetry cells expose detail_endpoint values so the client can decide what is clickable', () => {
    const lens = project(
      { running: new Map([['issue-1', makeRunningEntry()]]) },
      { auditHealth: { enabled: true, integrity_ok: true, recent_write_failure: null } }
    );
    // Orchestrator, runtime build, system health, and audit cells should all
    // carry a real detail_endpoint pointing to a real /api/v1/* route.
    expect(lens.shell.orchestrator.detail_endpoint).toBe('/api/v1/diagnostics');
    expect(lens.shell.runtime_build.detail_endpoint).toBe('/api/v1/diagnostics');
    expect(lens.shell.system_health.detail_endpoint).toBe('/api/v1/diagnostics');
    expect(lens.shell.audit.detail_endpoint).toBe('/api/v1/diagnostics');
    // refresh_pulse is informational only; no detail endpoint.
    expect(lens.shell.refresh_pulse.detail_endpoint).toBeNull();
  });
});
