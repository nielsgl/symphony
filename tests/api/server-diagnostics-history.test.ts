import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_EVENT,
  EVENT_VOCABULARY_VERSION,
  LocalApiError,
  LocalApiServer,
  REASON_CODES,
  StaticEventLoopHealthMonitor,
  closeServerAfterEach,
  deferred,
  makeDiagnosticsSource,
  makeEventLoopSummary,
  makeIssue,
  makeProjectHistoryIdentity,
  makeProjectHistorySummary,
  makeProjectHistoryTimeline,
  makeRunningEntry,
  makeState,
  makeThreadLineage,
  makeTranscriptDiagnostic,
  readSseEvents,
  replayForensicsBundle
} from './server-test-harness';
import type { DurableIdentity, ForensicsBundle } from './server-test-harness';

let server: LocalApiServer | null = null;

closeServerAfterEach(
  () => server,
  (nextServer) => {
    server = nextServer;
  }
);

describe('LocalApiServer diagnostics and history', () => {
  it('serves diagnostics, durable history, and ui continuity endpoints', async () => {
    const setUiState = vi.fn();

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: {
        getActiveProfile: () => ({
          name: 'balanced',
          approval_policy: 'on-request',
          thread_sandbox: 'workspace-write',
          turn_sandbox_policy: { type: 'workspace' },
          user_input_policy: 'fail_attempt'
        }),
        getPersistenceHealth: () => ({
          enabled: true,
          db_path: '/tmp/runtime.sqlite',
          retention_days: 14,
          run_count: 3,
          last_pruned_at: '2026-04-11T00:00:00.000Z',
          last_prune_failure_at: null,
          last_prune_failure_reason: null,
          last_prune_failure_detail: null,
          integrity_ok: true
        }),
        getLoggingHealth: () => ({
          root: '/tmp/log',
          active_file: '/tmp/log/symphony.log',
          rotation: { max_bytes: 10485760, max_files: 5 },
          sinks: ['stderr', 'file']
        }),
        listRunHistory: () => [
          {
            run_id: 'run-1',
            issue_id: 'issue-1',
            issue_identifier: 'ABC-1',
            started_at: '2026-04-10T10:00:00.000Z',
            ended_at: '2026-04-10T10:01:00.000Z',
            completed_at: '2026-04-10T10:01:00.000Z',
            terminal_status: 'succeeded',
            error_code: null,
            terminal_reason_code: null,
            terminal_reason_detail: null,
            root_cause_status: null,
            root_cause_reason_code: null,
            root_cause_reason_detail: null,
            root_cause_at: null,
            session_id: null,
            thread_id: null,
            turn_id: null,
            session_ids: ['thread-1-turn-1'],
            app_server_events: [
              {
                app_server_event_id: 'app-server-event-1',
                issue_run_id: 'issue_run_1',
                attempt_id: 'attempt_1',
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                observed_at: '2026-04-10T10:00:30.000Z',
                source_event_id: 'evt-warning-1',
                source_event_name: 'codex.protocol.warning',
                policy_version: 1,
                payload_class: 'protocol_lifecycle',
                detail_status: 'summary_only',
                redaction_status: 'redacted',
                summary: 'guardian warning',
                summary_fields: { protocol_event_category: 'warning', message: 'token=***REDACTED***' },
                redacted_excerpt: null,
                truncation: {
                  truncated: false,
                  original_bytes: 0,
                  excerpt_bytes: 0,
                  max_excerpt_bytes: 512
                },
                unavailable_reason_code: null,
                full_payload_stored: false
              }
            ]
          },
          {
            run_id: 'run-active',
            issue_id: 'issue-active',
            issue_identifier: 'ABC-ACTIVE',
            started_at: '2026-04-10T10:02:00.000Z',
            ended_at: null,
            completed_at: null,
            terminal_status: null,
            error_code: null,
            terminal_reason_code: null,
            terminal_reason_detail: null,
            root_cause_status: null,
            root_cause_reason_code: null,
            root_cause_reason_detail: null,
            root_cause_at: null,
            session_id: null,
            thread_id: null,
            turn_id: null,
            session_ids: []
          }
        ],
        reconstructThreadLineage: (threadId) =>
          threadId === 'thread-1'
            ? {
                issue_run: {
                  issue_run_id: 'issue_run_1',
                  issue_id: 'issue-1',
                  issue_identifier: 'ABC-1',
                  started_at: '2026-04-10T10:00:00.000Z',
                  ended_at: null,
                  status: 'running',
                  reason_code: 'dispatch_started',
                  reason_detail: null
                },
                attempt: {
                  attempt_id: 'attempt_1',
                  issue_run_id: 'issue_run_1',
                  attempt_number: 0,
                  started_at: '2026-04-10T10:00:01.000Z',
                  ended_at: null,
                  status: 'running',
                  reason_code: 'attempt_started',
                  reason_detail: null
                },
                thread: {
                  thread_id: 'thread-1',
                  attempt_id: 'attempt_1',
                  started_at: '2026-04-10T10:00:02.000Z',
                  ended_at: null,
                  status: 'running',
                  reason_code: 'codex_session_started',
                  reason_detail: null
                },
                turns: [],
                state_transitions: [
                  {
                    state_transition_id: 'state_transition_1',
                    issue_run_id: 'issue_run_1',
                    attempt_id: 'attempt_1',
                    thread_id: 'thread-1',
                    turn_id: null,
                    from_status: 'running',
                    to_status: 'retrying',
                    transitioned_at: '2026-04-10T10:01:00.000Z',
                    status: 'retrying',
                    reason_code: 'normal_completion',
                    reason_detail: 'continuation scheduled'
                  }
                ]
              }
            : null,
        getUiState: () => ({
          selected_issue: 'ABC-1',
          filters: { status: 'all', query: 'ABC' },
          panel_state: { issue_detail_open: false }
        }),
        setUiState,
        getPromptFallbackActive: () => false,
        getRuntimeResolution: () => ({
          workflow_path: '/tmp/WORKFLOW.md',
          workflow_dir: '/tmp',
          workspace_root: '/tmp/workspaces',
          workspace_root_source: 'workflow',
          server: {
            host: '127.0.0.1',
            port: 3000
          },
          provisioner_type: 'none',
          repo_root: null,
          base_ref: null,
          branch_name_template: null
        }),
        getWorkspaceProvisioner: () => ({
          provisioner_type: 'none',
          repo_root: null,
          base_ref: null,
          branch_name_template: null,
          last_provision_result: null,
          last_teardown_result: null,
          last_error_code: null,
          last_verification_result: null,
          last_cleanup_on_failure_result: null,
          verification_mode: 'none',
          last_integrity_status: null,
          last_integrity_reason_code: null,
          last_integrity_checked_at: null,
          last_integrity_reconciled_at: null
        }),
        getWorkspaceCopyIgnored: () => ({
          enabled: false,
          include_file: '/tmp/.worktreeinclude',
          from: 'primary_worktree',
          conflict_policy: 'skip',
          require_gitignored: true,
          max_files: 10000,
          max_total_bytes: 5 * 1024 * 1024 * 1024,
          last_status: null,
          last_error_code: null,
          last_error_message: null,
          source_path: null,
          copied_files: 0,
          skipped_existing: 0,
          blocked_files: 0,
          bytes_copied: 0,
          duration_ms: 0
        }),
        getBreakerStatuses: () => [
          {
            issue_id: 'issue-1',
            issue_identifier: 'ABC-1',
            breaker_active: true,
            breaker_hit_count: 4,
            breaker_window_minutes: 30,
            breaker_first_hit_at: '2026-04-10T10:00:00.000Z',
            breaker_last_hit_at: '2026-04-10T10:03:00.000Z'
          }
        ],
        getBlockedLatchStats: () => ({
          blocked_latch_active_count: 1,
          blocked_event_quarantine_total: 2,
          blocked_event_allowlist_total: 0,
          blocked_event_reject_total: 0,
          blocked_latch_violation_total: 0
        })
      }
    });

    await server.listen();
    const address = server.address();

    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      active_profile: { name: string };
      persistence: { retention_days: number };
      logging: { root: string; active_file: string; sinks: string[] };
      breaker_statuses: Array<{
        issue_identifier: string;
        breaker_active: boolean;
        breaker_hit_count: number;
        breaker_window_minutes: number;
        breaker_first_hit_at: string | null;
        breaker_last_hit_at: string | null;
      }>;
      event_vocabulary_version: string;
      workflow: {
        prompt_fallback_active: boolean;
      };
      token_accounting: {
        mode: string;
        canonical_precedence: string[];
        excludes_last_usage_for_totals: boolean;
        no_telemetry_warning_threshold_ms: number;
        observed_dimensions: {
          cached_input_tokens: boolean;
          reasoning_output_tokens: boolean;
          model_context_window: boolean;
        };
      };
      token_telemetry_status: 'unavailable' | 'pending' | 'available';
      token_telemetry_last_source: string | null;
      token_telemetry_last_at_ms: number | null;
      blocked_latch: {
        blocked_latch_active_count: number;
        blocked_event_quarantine_total: number;
        blocked_event_allowlist_total: number;
        blocked_event_reject_total: number;
        blocked_latch_violation_total: number;
      };
    };
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.active_profile.name).toBe('balanced');
    expect(diagnosticsPayload.persistence.retention_days).toBe(14);
    expect(diagnosticsPayload.logging.root).toBe('/tmp/log');
    expect(diagnosticsPayload.logging.active_file).toBe('/tmp/log/symphony.log');
    expect(diagnosticsPayload.logging.sinks).toEqual(['stderr', 'file']);
    expect(diagnosticsPayload.breaker_statuses).toEqual([
      {
        issue_id: 'issue-1',
        issue_identifier: 'ABC-1',
        breaker_active: true,
        breaker_hit_count: 4,
        breaker_window_minutes: 30,
        breaker_first_hit_at: '2026-04-10T10:00:00.000Z',
        breaker_last_hit_at: '2026-04-10T10:03:00.000Z'
      }
    ]);
    expect(diagnosticsPayload.event_vocabulary_version).toBe(EVENT_VOCABULARY_VERSION);
    expect(diagnosticsPayload.workflow.prompt_fallback_active).toBe(false);
    expect(diagnosticsPayload.token_accounting.mode).toBe('strict_canonical');
    expect(diagnosticsPayload.token_accounting.canonical_precedence).toEqual([
      'terminal_turn_summary',
      'thread/tokenUsage/updated.params.tokenUsage.total',
      'params.info.total_token_usage',
      'params.info.totalTokenUsage',
      'params.total_token_usage',
      'params.totalTokenUsage',
      'params.usage.total_token_usage',
      'params.usage.totalTokenUsage',
      'last_token_usage',
      'persisted_fallback_usage'
    ]);
    expect(diagnosticsPayload.token_accounting.excludes_last_usage_for_totals).toBe(false);
    expect(diagnosticsPayload.token_accounting.no_telemetry_warning_threshold_ms).toBe(120_000);
    expect(diagnosticsPayload.token_telemetry_status).toBe('unavailable');
    expect(diagnosticsPayload.token_telemetry_last_source).toBeNull();
    expect(diagnosticsPayload.token_telemetry_last_at_ms).toBeNull();
    expect(diagnosticsPayload.blocked_latch).toEqual({
      blocked_latch_active_count: 1,
      blocked_event_quarantine_total: 2,
      blocked_event_allowlist_total: 0,
      blocked_event_reject_total: 0,
      blocked_latch_violation_total: 0
    });
    expect(diagnosticsPayload.token_accounting.observed_dimensions.cached_input_tokens).toBe(false);
    expect((diagnosticsPayload as Record<string, unknown>).runtime_resolution).toMatchObject({
      workflow_path: '/tmp/WORKFLOW.md',
      workspace_root: '/tmp/workspaces'
    });

    const historyResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/history?limit=2`);
    const historyPayload = (await historyResponse.json()) as {
      runs: Array<{
        run_id: string;
        terminal_status: string | null;
        completed_at: string | null;
        app_server_events?: Array<{ full_payload_stored: boolean; redacted_excerpt: string | null; summary_fields: Record<string, unknown> }>;
      }>;
    };
    expect(historyResponse.status).toBe(200);
    expect(historyPayload.runs[0].run_id).toBe('run-1');
    expect(historyPayload.runs.find((run) => run.run_id === 'run-1')).toMatchObject({
      terminal_status: 'succeeded',
      completed_at: '2026-04-10T10:01:00.000Z',
      app_server_events: [
        expect.objectContaining({
          full_payload_stored: false,
          redacted_excerpt: null,
          summary_fields: expect.objectContaining({ protocol_event_category: 'warning' })
        })
      ]
    });
    expect(JSON.stringify(historyPayload)).not.toContain('raw transcript');
    expect(historyPayload.runs.find((run) => run.run_id === 'run-active')).toMatchObject({
      terminal_status: null,
      completed_at: null
    });

    const lineageResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/history/threads/thread-1`);
    const lineagePayload = (await lineageResponse.json()) as {
      lineage: {
        issue_run: { issue_identifier: string };
        thread: { thread_id: string };
        state_transitions: Array<{ to_status: string; reason_code: string | null }>;
      };
    };
    expect(lineageResponse.status).toBe(200);
    expect(lineagePayload.lineage.issue_run.issue_identifier).toBe('ABC-1');
    expect(lineagePayload.lineage.thread.thread_id).toBe('thread-1');
    expect(lineagePayload.lineage.state_transitions[0]).toMatchObject({
      to_status: 'retrying',
      reason_code: 'normal_completion'
    });

    const uiStateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ui-state`);
    const uiStatePayload = (await uiStateResponse.json()) as {
      state: { selected_issue: string | null; filters: { query: string } };
    };
    expect(uiStateResponse.status).toBe(200);
    expect(uiStatePayload.state.selected_issue).toBe('ABC-1');

    const saveResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ui-state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        state: {
          selected_issue: 'ABC-2',
          filters: { status: 'running', query: 'token=secret123' },
          event_feed_filter: 'warn',
          panels: {
            throughput_open: false,
            runtime_events_open: true
          },
          panel_state: { issue_detail_open: true }
        }
      })
    });

    expect(saveResponse.status).toBe(202);
    expect(setUiState).toHaveBeenCalledWith({
      selected_issue: 'ABC-2',
      filters: { status: 'running', query: 'token=secret123' },
      event_feed_filter: 'warn',
      panels: {
        throughput_open: false,
        runtime_events_open: true
      },
      panel_state: { issue_detail_open: true }
    });
  });

  it('serves drain mode and quiescence state on GET /api/v1/diagnostics', async () => {
    const state = makeState({
      drain_mode: {
        active: true,
        entered_at_ms: Date.parse('2026-04-10T10:00:30.000Z'),
        updated_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
        reason: 'operator requested restart'
      },
      quiescence: {
        safe_to_shutdown: false,
        state: 'blocked',
        updated_at_ms: Date.parse('2026-04-10T10:01:00.000Z'),
        blockers: [
          {
            category: 'persistence_history_write',
            count: 1,
            detail: 'history write health is degraded',
            issue_identifiers: []
          }
        ],
        blocker_counts: {
          active_worker: 0,
          live_codex_app_server_process: 0,
          pending_retry: 0,
          in_flight_tracker_write: 0,
          persistence_history_write: 1,
          unknown_degraded_blocker_source_health: 0,
          stale_runtime: 0,
          unknown_current_build_identity: 0
        }
      }
    } as any);

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => state
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: makeDiagnosticsSource(),
      nowMs: () => Date.parse('2026-04-10T10:03:00.000Z')
    });

    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const payload = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(payload.drain_mode).toMatchObject({
      active: true,
      entered_at: '2026-04-10T10:00:30.000Z',
      updated_at: '2026-04-10T10:01:00.000Z',
      reason: 'operator requested restart'
    });
    expect(payload.quiescence).toMatchObject({
      safe_to_shutdown: false,
      state: 'blocked',
      blocker_counts: {
        persistence_history_write: 1
      }
    });
  });

  it('serves bounded project history ticket rows and detail timelines', async () => {
    const completedIdentity = makeProjectHistoryIdentity();
    const activeIdentity = makeProjectHistoryIdentity({
      ticketKey: 'ticket-abc-active',
      remoteIssueId: 'remote-active',
      humanIssueIdentifier: 'ABC-ACTIVE'
    });
    const completedTimeline = makeProjectHistoryTimeline(completedIdentity, {
      blockers: [
        {
          blocker_id: 'blocker-1',
          issue_run_id: 'ticket-abc-1-issue-run',
          attempt_id: 'ticket-abc-1-attempt-0',
          thread_id: 'ticket-abc-1-thread',
          turn_id: 'ticket-abc-1-turn',
          blocker_type: 'tool_output',
          status: 'resolved',
          reason_code: 'missing_tool_output',
          reason_detail: 'recovered',
          blocked_at: '2026-04-10T10:05:00.000Z',
          resolved_at: '2026-04-10T10:06:00.000Z'
        }
      ],
      evidence_references: [
        {
          evidence_reference_id: 'evidence-1',
          issue_run_id: 'ticket-abc-1-issue-run',
          attempt_id: 'ticket-abc-1-attempt-0',
          thread_id: 'ticket-abc-1-thread',
          turn_id: 'ticket-abc-1-turn',
          evidence_kind: 'test_output',
          uri: 'file://validation/project-history.txt',
          title: 'project history proof',
          metadata: { command: 'npm test -- tests/api/server.test.ts' },
          recorded_at: '2026-04-10T10:19:30.000Z'
        }
      ],
      ticket_references: [
        {
          ticket_reference_id: 'pr-1',
          project_key: 'project-main',
          ticket_key: 'ticket-abc-1',
          issue_run_id: 'ticket-abc-1-issue-run',
          attempt_id: 'ticket-abc-1-attempt-0',
          thread_id: 'ticket-abc-1-thread',
          turn_id: 'ticket-abc-1-turn',
          reference_kind: 'pull_request',
          availability: 'available',
          uri: 'https://github.com/nielsgl/symphony/pull/230',
          label: 'PR #230',
          external_id: '230',
          state: 'open',
          metadata: { check: 'green' },
          observed_at: '2026-04-10T10:19:45.000Z',
          observation_hash: 'pr-hash',
          duplicate_count: 1,
          last_observed_at: '2026-04-10T10:19:45.000Z'
        }
      ],
      operator_actions: [
        {
          operator_action_id: 'operator-1',
          project_key: 'project-main',
          ticket_key: 'ticket-abc-1',
          issue_run_id: 'ticket-abc-1-issue-run',
          attempt_id: 'ticket-abc-1-attempt-0',
          thread_id: 'ticket-abc-1-thread',
          turn_id: 'ticket-abc-1-turn',
          action: 'resume',
          actor: 'operator',
          result: 'accepted',
          result_code: null,
          message: 'operator answer accepted',
          reason_note: 'continue',
          phase: 'implementation',
          state_context: { from: 'blocked' },
          requested_at: '2026-04-10T10:06:00.000Z',
          observed_at: '2026-04-10T10:06:01.000Z',
          observation_hash: 'operator-hash',
          duplicate_count: 1,
          last_observed_at: '2026-04-10T10:06:01.000Z'
        }
      ],
      app_server_events: [
        {
          app_server_event_id: 'app-event-1',
          issue_run_id: 'ticket-abc-1-issue-run',
          attempt_id: 'ticket-abc-1-attempt-0',
          thread_id: 'ticket-abc-1-thread',
          turn_id: 'ticket-abc-1-turn',
          observed_at: '2026-04-10T10:07:00.000Z',
          source_event_id: 'event-1',
          source_event_name: 'thread/tokenUsage/updated',
          policy_version: 1,
          payload_class: 'protocol_lifecycle',
          detail_status: 'redacted_truncated_excerpt',
          redaction_status: 'redacted',
          summary: 'token update',
          summary_fields: { total_tokens: 42 },
          redacted_excerpt: 'token=***REDACTED***',
          truncation: { truncated: true, original_bytes: 1024, excerpt_bytes: 64, max_excerpt_bytes: 64 },
          unavailable_reason_code: null,
          full_payload_stored: false
        }
      ],
      token_model_facts: [
        {
          token_model_fact_id: 'token-1',
          issue_run_id: 'ticket-abc-1-issue-run',
          attempt_id: 'ticket-abc-1-attempt-0',
          thread_id: 'ticket-abc-1-thread',
          turn_id: 'ticket-abc-1-turn',
          requested_model: 'gpt-5.4',
          effective_model: 'gpt-5.4',
          model_source: 'terminal_turn_summary',
          input_tokens: 20,
          output_tokens: 22,
          cached_input_tokens: null,
          reasoning_output_tokens: null,
          total_tokens: 42,
          model_context_window: null,
          telemetry_confidence: 'observed_live',
          observed_at: '2026-04-10T10:07:00.000Z'
        }
      ]
    });
    const activeTimeline = makeProjectHistoryTimeline(activeIdentity, {
      issue_runs: [
        {
          issue_run_id: 'ticket-abc-active-issue-run',
          issue_id: 'remote-active',
          issue_identifier: 'ABC-ACTIVE',
          identity: activeIdentity,
          started_at: '2026-04-10T11:00:00.000Z',
          ended_at: null,
          status: 'running',
          reason_code: 'dispatch_started',
          reason_detail: null
        }
      ],
      attempts: [],
      threads: [],
      turns: [],
      phase_spans: [],
      state_transitions: [],
      terminal_outcomes: [],
      tracker_snapshots: [],
      app_server_events: [],
      token_model_facts: []
    });
    const timelines = new Map([
      [completedIdentity.ticket.key, completedTimeline],
      [activeIdentity.ticket.key, activeTimeline]
    ]);
    const summaries = [makeProjectHistorySummary(completedTimeline), makeProjectHistorySummary(activeTimeline)];
    const reconstructTicketTimeline = vi.fn((identity: DurableIdentity) => {
      const timeline = timelines.get(identity.ticket.key);
      if (!timeline) {
        throw new Error(`missing timeline for ${identity.ticket.key}`);
      }
      return timeline;
    });

    server = new LocalApiServer({
      snapshotSource: { getStateSnapshot: () => makeState() },
      refreshSource: { tick: vi.fn(async () => undefined) },
      diagnosticsSource: makeDiagnosticsSource({
        getPersistenceHealth: () => ({
          enabled: true,
          db_path: '/tmp/runtime.sqlite',
          retention_days: 14,
          run_count: 2,
          last_pruned_at: null,
          integrity_ok: true,
          history_schema: {
            schema_name: 'project_execution_history',
            target_version: 6,
            applied_version: 6,
            status: 'degraded',
            degraded_reason_code: 'history_write_failed',
            degraded_detail: 'appendTicketTerminalOutcome: history_terminal_outcome_write_failed',
            updated_at: '2026-04-10T10:00:00.000Z',
            migrations: []
          }
        }),
        listProjectTicketIdentities: (_projectKey: string, page: { limit?: number; offset?: number } = {}) => ({
          items: [completedIdentity, activeIdentity].slice(page.offset ?? 0, (page.offset ?? 0) + (page.limit ?? 50)),
          limit: page.limit ?? 50,
          offset: page.offset ?? 0,
          has_more: (page.offset ?? 0) + (page.limit ?? 50) < 2,
          total: 2
        }),
        listProjectTicketSummaries: (_projectKey: string, page: { limit?: number; offset?: number } = {}) => ({
          items: summaries.slice(page.offset ?? 0, (page.offset ?? 0) + (page.limit ?? 50)),
          limit: page.limit ?? 50,
          offset: page.offset ?? 0,
          has_more: (page.offset ?? 0) + (page.limit ?? 50) < 2,
          total: 2
        }),
        getProjectTicketIdentity: (_projectKey: string, ticketKey: string) =>
          ticketKey === completedIdentity.ticket.key ? completedIdentity : null,
        reconstructTicketTimeline
      })
    });
    await server.listen();
    const address = server.address();

    const listResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/projects/project-main/history/tickets?limit=1`);
    const listPayload = (await listResponse.json()) as {
      health: { status: string; counts: { runs: number; tickets: number | null }; retention: { last_prune: { status: string } } };
      page: { limit: number; has_more: boolean; total: number };
      tickets: Array<{ state: string; summary: { attempt_count: number; total_tokens: number | null }; facts: Array<{ status: string }> }>;
    };
    expect(listResponse.status).toBe(200);
    expect(listPayload.health).toMatchObject({
      status: 'degraded',
      counts: { runs: 2, tickets: 2 },
      retention: { last_prune: { status: 'never_run' } }
    });
    expect(listPayload.page).toMatchObject({ limit: 1, has_more: true, total: 2 });
    expect(listPayload.tickets).toHaveLength(1);
    expect(listPayload.tickets[0]).toMatchObject({
      state: 'completed',
      summary: { attempt_count: 1, total_tokens: 42 }
    });
    expect(listPayload.tickets[0]).not.toHaveProperty('attempts');
    expect(listPayload.tickets[0]).not.toHaveProperty('timeline');
    expect(listPayload.tickets[0].facts.map((fact) => fact.status)).toEqual(expect.arrayContaining(['degraded', 'present', 'redacted', 'truncated']));
    expect(reconstructTicketTimeline).not.toHaveBeenCalled();

    const activeListResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/projects/project-main/history/tickets?limit=1&offset=1`);
    const activeListPayload = (await activeListResponse.json()) as {
      tickets: Array<{ state: string; facts: Array<{ status: string; reason_code: string | null }> }>;
    };
    expect(activeListResponse.status).toBe(200);
    expect(activeListPayload.tickets[0].state).toBe('active');
    expect(activeListPayload.tickets[0].facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'lifecycle_pending', reason_code: 'project_history_terminal_outcome_missing' }),
        expect.objectContaining({ status: 'optional_unavailable', reason_code: 'project_history_app_server_lite_summaries_missing' })
      ])
    );
    expect(reconstructTicketTimeline).not.toHaveBeenCalled();

    const detailResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/projects/project-main/history/tickets/${completedIdentity.ticket.key}`
    );
    const detailPayload = (await detailResponse.json()) as {
      ticket_identity: { key: string };
      attempts: unknown[];
      phases: unknown[];
      state_transitions: unknown[];
      thread_references: unknown[];
      turn_references: unknown[];
      outcomes: unknown[];
      blockers: unknown[];
      evidence_references: unknown[];
      tracker_facts: unknown[];
      pr_and_reference_facts: unknown[];
      operator_facts: unknown[];
      app_server_lite_summaries: unknown[];
      token_model_summaries: unknown[];
    };
    expect(detailResponse.status).toBe(200);
    expect(detailPayload.ticket_identity.key).toBe(completedIdentity.ticket.key);
    expect(reconstructTicketTimeline).toHaveBeenCalledTimes(1);
    expect(detailPayload.attempts).toHaveLength(1);
    expect(detailPayload.phases).toHaveLength(1);
    expect(detailPayload.state_transitions).toHaveLength(1);
    expect(detailPayload.thread_references).toHaveLength(1);
    expect(detailPayload.turn_references).toHaveLength(1);
    expect(detailPayload.outcomes).toHaveLength(1);
    expect(detailPayload.blockers).toHaveLength(1);
    expect(detailPayload.evidence_references).toHaveLength(1);
    expect(detailPayload.tracker_facts).toHaveLength(1);
    expect(detailPayload.pr_and_reference_facts).toHaveLength(1);
    expect(detailPayload.operator_facts).toHaveLength(1);
    expect(detailPayload.app_server_lite_summaries).toHaveLength(1);
    expect(detailPayload.token_model_summaries).toHaveLength(1);

    const consumerSummaryResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/projects/project-main/history/tickets/${completedIdentity.ticket.key}/consumer-summary`
    );
    const consumerSummaryPayload = (await consumerSummaryResponse.json()) as {
      schema_version: string;
      read_only: boolean;
      deferred_capabilities: string[];
      current_ticket_state: { state: string; current_status: string };
      attempts: { total: number; repeated: boolean };
      recent_phases: unknown[];
      blockers: { resolved_count: number };
      token_model: { status: string; total_tokens: number | null; effective_models: string[] };
      app_server_lite: { status: string; excerpts: unknown[] };
      evidence_references: unknown[];
    };
    expect(consumerSummaryResponse.status).toBe(200);
    expect(consumerSummaryPayload).toMatchObject({
      schema_version: 'symphony.project_history.consumer_summary.v1',
      read_only: true,
      deferred_capabilities: ['validation_reuse', 'phase_handoff_packets', 'drain_mode', 'operator_steering'],
      current_ticket_state: { state: 'completed', current_status: 'Agent Review' },
      attempts: { total: 1, repeated: false },
      blockers: { resolved_count: 1 },
      token_model: { status: 'present', total_tokens: 42, effective_models: ['gpt-5.4'] },
      app_server_lite: { status: 'present' }
    });
    expect(consumerSummaryPayload.recent_phases).toHaveLength(1);
    expect(consumerSummaryPayload.app_server_lite.excerpts).toHaveLength(1);
    expect(consumerSummaryPayload.evidence_references).toHaveLength(1);

    const healthResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/projects/project-main/history/health`);
    const healthPayload = (await healthResponse.json()) as {
      status: string;
      writes: { status: string };
      projections: { status: string };
      app_server_lite: { status: string; redacted_event_count: number; truncated_event_count: number; summary_only_event_count: number };
    };
    expect(healthResponse.status).toBe(200);
    expect(reconstructTicketTimeline).toHaveBeenCalledTimes(2);
    expect(healthPayload).toMatchObject({
      status: 'degraded',
      writes: { status: 'healthy' },
      projections: { status: 'degraded' },
      app_server_lite: { status: 'healthy', redacted_event_count: 1, truncated_event_count: 1, summary_only_event_count: 0 }
    });

    const missingSummaryResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/projects/project-main/history/tickets/missing-ticket/consumer-summary`
    );
    const missingSummaryPayload = (await missingSummaryResponse.json()) as { error: { code: string } };
    expect(missingSummaryResponse.status).toBe(404);
    expect(missingSummaryPayload.error.code).toBe('project_history_ticket_not_found');
  });

  it('returns a typed error when project history consumer summaries are unavailable', async () => {
    server = new LocalApiServer({
      snapshotSource: { getStateSnapshot: () => makeState() },
      refreshSource: { tick: vi.fn(async () => undefined) },
      diagnosticsSource: makeDiagnosticsSource({
        getProjectTicketIdentity: undefined,
        reconstructTicketTimeline: undefined
      })
    });
    await server.listen();
    const address = server.address();

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/projects/project-main/history/tickets/ticket-abc-1/consumer-summary`);
    const payload = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe('project_history_unavailable');
  });

  it('reports observed token accounting dimensions in diagnostics from state snapshot', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            token_telemetry_status: 'available',
            token_telemetry_last_source: 'terminal_turn_summary',
            token_telemetry_last_at_ms: Date.parse('2026-04-10T10:01:00.000Z')
          })
        ]
      ]),
      codex_totals: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        cached_input_tokens: 25,
        reasoning_output_tokens: 7,
        model_context_window: 128000,
        seconds_running: 10
      }
    });

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => state
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      diagnosticsSource: {
        getActiveProfile: () => ({
          name: 'balanced',
          approval_policy: 'on-request',
          thread_sandbox: 'workspace-write',
          turn_sandbox_policy: { type: 'workspace' },
          user_input_policy: 'fail_attempt'
        }),
        getPersistenceHealth: () => ({
          enabled: false,
          db_path: null,
          retention_days: 14,
          run_count: 0,
          last_pruned_at: null,
          last_prune_failure_at: null,
          last_prune_failure_reason: null,
          last_prune_failure_detail: null,
          integrity_ok: true
        }),
        getLoggingHealth: () => ({
          root: '/tmp/log',
          active_file: '/tmp/log/symphony.log',
          rotation: { max_bytes: 10485760, max_files: 5 },
          sinks: ['stderr', 'file']
        }),
        listRunHistory: () => [],
        getUiState: () => null,
        setUiState: () => undefined,
        getPromptFallbackActive: () => false,
        getRuntimeResolution: () => ({
          workflow_path: '/tmp/WORKFLOW.md',
          workflow_dir: '/tmp',
          workspace_root: '/tmp/workspaces',
          workspace_root_source: 'workflow',
          server: {
            host: '127.0.0.1',
            port: 3000
          },
          provisioner_type: 'none',
          repo_root: null,
          base_ref: null,
          branch_name_template: null
        }),
        getWorkspaceProvisioner: () => ({
          provisioner_type: 'none',
          repo_root: null,
          base_ref: null,
          branch_name_template: null,
          last_provision_result: null,
          last_teardown_result: null,
          last_error_code: null,
          last_verification_result: null,
          last_cleanup_on_failure_result: null,
          verification_mode: 'none',
          last_integrity_status: null,
          last_integrity_reason_code: null,
          last_integrity_checked_at: null,
          last_integrity_reconciled_at: null
        }),
        getWorkspaceCopyIgnored: () => ({
          enabled: false,
          include_file: '/tmp/.worktreeinclude',
          from: 'primary_worktree',
          conflict_policy: 'skip',
          require_gitignored: true,
          max_files: 10000,
          max_total_bytes: 5 * 1024 * 1024 * 1024,
          last_status: null,
          last_error_code: null,
          last_error_message: null,
          source_path: null,
          copied_files: 0,
          skipped_existing: 0,
          blocked_files: 0,
          bytes_copied: 0,
          duration_ms: 0
        })
      }
    });

    await server.listen();
    const address = server.address();
    const diagnosticsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/diagnostics`);
    const diagnosticsPayload = (await diagnosticsResponse.json()) as {
      token_accounting: {
        observed_dimensions: {
          cached_input_tokens: boolean;
          reasoning_output_tokens: boolean;
          model_context_window: boolean;
        };
      };
      token_telemetry_status: 'unavailable' | 'pending' | 'available';
      token_telemetry_last_source: string | null;
      token_telemetry_last_at_ms: number | null;
    };

    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnosticsPayload.token_accounting.observed_dimensions).toEqual({
      cached_input_tokens: true,
      reasoning_output_tokens: true,
      model_context_window: true
    });
    expect(diagnosticsPayload.token_telemetry_status).toBe('available');
    expect(diagnosticsPayload.token_telemetry_last_source).toBe('terminal_turn_summary');
    expect(diagnosticsPayload.token_telemetry_last_at_ms).toBe(Date.parse('2026-04-10T10:01:00.000Z'));
    expect((diagnosticsPayload as Record<string, unknown>).runtime_resolution).toMatchObject({
      workflow_path: '/tmp/WORKFLOW.md',
      workspace_root: '/tmp/workspaces',
      workspace_root_source: 'workflow'
    });
  });
});
