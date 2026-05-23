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

describe('LocalApiServer operator actions', () => {
  it('serves GET /api/v1/:issue_identifier projection and returns 404 for unknown issue', async () => {
    const state = makeState({
      running: new Map([
        [
          'issue-1',
          makeRunningEntry({
            issue: makeIssue({ identifier: 'ABC-1' }),
            retry_attempt: 3,
            last_codex_timestamp_ms: null
          })
        ]
      ])
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
          enabled: true,
          db_path: '/tmp/test.sqlite',
          retention_days: 14,
          run_count: 1,
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
            session_ids: ['thread-1-turn-1']
          }
        ],
        getUiState: () => ({
          selected_issue: 'ABC-1',
          filters: { status: 'all', query: '' },
          panel_state: { issue_detail_open: true }
        }),
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

    const knownResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ABC-1`);
    const knownPayload = (await knownResponse.json()) as Record<string, unknown>;
    expect(knownResponse.status).toBe(200);
    expect(knownPayload.issue_identifier).toBe('ABC-1');
    expect(knownPayload.status).toBe('running');
    expect((knownPayload.workspace as { host: string | null }).host).toBeNull();
    expect((knownPayload.running as { session_id: string | null }).session_id).toBe('thread-1-turn-1');
    expect((knownPayload.running as { thread_id: string | null }).thread_id).toBe('thread-1');
    expect((knownPayload.running as { turn_id: string | null }).turn_id).toBe('turn-1');
    expect((knownPayload.running as { codex_app_server_pid: string | null }).codex_app_server_pid).toBe('9999');
    expect((knownPayload.running as { workspace_path: string | null }).workspace_path).toBe('/tmp/symphony/ABC-1');
    expect((knownPayload.logs as { codex_session_logs: unknown[] }).codex_session_logs).toEqual([]);
    expect(knownPayload.tracked).toEqual({});

    const missingResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ABC-999`);
    const missingPayload = (await missingResponse.json()) as { error: { code: string; message: string } };
    expect(missingResponse.status).toBe(404);
    expect(missingPayload.error.code).toBe('issue_not_found');
    expect(missingPayload.error.message).toContain('ABC-999');
  });

  it('projects blocked issues and resumes them via POST /api/v1/issues/:issue_identifier/resume', async () => {
    const state = makeState({
      operator_actions: new Map([
        [
          'issue-3',
          [
            {
              action: 'resume',
              requested_at_ms: Date.parse('2026-04-10T10:04:00.000Z'),
              result: 'rejected',
              result_code: 'resume_failed',
              message: 'requires progress'
            }
          ]
        ]
      ]),
      blocked_inputs: new Map([
        [
          'issue-3',
          {
            issue_id: 'issue-3',
            issue_identifier: 'ABC-3',
            attempt: 2,
            worker_host: 'build-2',
            workspace_path: '/tmp/symphony/ABC-3',
            provisioner_type: 'worktree',
            branch_name: 'feature/ABC-3',
            repo_root: '/tmp/source',
            workspace_exists: true,
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'operator_action_required_workspace_conflict',
            stop_reason_detail: 'workspace_unprovisioned_conflict: worktree_branch_conflict',
            conflict_files: [{ path: 'src/orchestrator/core.ts', status: 'unstaged' }],
            resolution_hints: ['Resolve branch/worktree mismatch before manual resume.'],
            previous_thread_id: 'thread-prev',
            previous_session_id: 'thread-prev-turn-prev',
            blocked_at_ms: Date.parse('2026-04-10T10:03:00.000Z'),
            requires_manual_resume: true,
            pending_input: null,
            session_console: []
          }
        ]
      ])
    });
    const resumeBlockedIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' }));

    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => state
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        resumeBlockedIssue,
        cancelBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' })),
        submitBlockedIssueInput: vi.fn(async () => ({
          ok: true as const,
          issue_id: 'issue-3',
          request_id: 'req-1',
          resume_mode: 'fallback' as const,
          resume_reason_code: 'transport_unsupported',
          requested_at: '2026-05-04T00:00:00.000Z',
          request_lineage: { previous_thread_id: null, previous_session_id: null }
        }))
      }
    });

    await server.listen();
    const address = server.address();

    const stateResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/state`);
    const statePayload = (await stateResponse.json()) as {
      counts: { blocked: number };
      blocked: Array<{
        issue_identifier: string;
        requires_manual_resume: boolean;
        turn_control_state: string;
        progress_signal_state: string;
        operator_actions: Array<{ action: string; result: string }>;
      }>;
    };
    expect(stateResponse.status).toBe(200);
    expect(statePayload.counts.blocked).toBe(1);
    expect(statePayload.blocked[0]).toMatchObject({
      issue_identifier: 'ABC-3',
      requires_manual_resume: true,
      turn_control_state: 'blocked_manual_resume',
      progress_signal_state: 'advancing',
      operator_actions: [{ action: 'resume', result: 'rejected' }],
      conflict_files: [{ path: 'src/orchestrator/core.ts', status: 'unstaged' }]
    });

    const issueResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/ABC-3`);
    const issuePayload = (await issueResponse.json()) as {
      status: string;
      operator_actions: Array<{ action: string; result: string }>;
      blocked: { stop_reason_code: string; requires_manual_resume: boolean; turn_control_state: string };
    };
    expect(issueResponse.status).toBe(200);
    expect(issuePayload.status).toBe('blocked');
    expect(issuePayload.blocked).toMatchObject({
      stop_reason_code: 'operator_action_required_workspace_conflict',
      requires_manual_resume: true,
      turn_control_state: 'blocked_manual_resume',
      resolution_hints: ['Resolve branch/worktree mismatch before manual resume.']
    });
    expect(issuePayload.operator_actions).toEqual([{ action: 'resume', requested_at_ms: Date.parse('2026-04-10T10:04:00.000Z'), result: 'rejected', result_code: 'resume_failed', message: 'requires progress' }]);

    const resumeResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason_note: 'operator resolved conflict' })
    });
    const resumePayload = (await resumeResponse.json()) as { resumed: boolean; issue_identifier: string };
    expect(resumeResponse.status).toBe(202);
    expect(resumePayload).toMatchObject({
      resumed: true,
      issue_identifier: 'ABC-3'
    });
    expect(resumeBlockedIssue).toHaveBeenCalledWith('ABC-3', { actor: undefined, reason_note: 'operator resolved conflict' });
  });

  it('requires confirmation before dispatching cancel blocked issue requests', async () => {
    const cancelBlockedIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' }));
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        resumeBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' })),
        cancelBlockedIssue,
        submitBlockedIssueInput: vi.fn(async () => ({
          ok: true as const,
          issue_id: 'issue-3',
          request_id: 'req-1',
          resume_mode: 'fallback' as const,
          resume_reason_code: 'transport_unsupported',
          requested_at: '2026-05-04T00:00:00.000Z',
          request_lineage: { previous_thread_id: null, previous_session_id: null }
        }))
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cancel_reason: 'operator_cancel_return_to_backlog' })
    });
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('confirmation_required');
    expect(cancelBlockedIssue).not.toHaveBeenCalled();
  });

  it('accepts confirmed cancel blocked issue requests and returns destination state', async () => {
    const cancelBlockedIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' }));
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        resumeBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' })),
        cancelBlockedIssue,
        submitBlockedIssueInput: vi.fn(async () => ({
          ok: true as const,
          issue_id: 'issue-3',
          request_id: 'req-1',
          resume_mode: 'fallback' as const,
          resume_reason_code: 'transport_unsupported',
          requested_at: '2026-05-04T00:00:00.000Z',
          request_lineage: { previous_thread_id: null, previous_session_id: null }
        }))
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cancel_reason: 'operator_cancel_return_to_backlog', confirmed: true })
    });
    const payload = (await response.json()) as { cancelled: boolean; issue_identifier: string; moved_to_state: string };

    expect(response.status).toBe(202);
    expect(payload.cancelled).toBe(true);
    expect(payload.issue_identifier).toBe('ABC-3');
    expect(payload.moved_to_state).toBe('Todo');
    expect(cancelBlockedIssue).toHaveBeenCalledWith('ABC-3', {
      actor: undefined,
      cancel_reason: 'operator_cancel_return_to_backlog',
      confirmed: true,
      reason_note: 'operator_cancel_return_to_backlog'
    });
  });

  it('accepts operator action console requests for cancel-turn, requeue, and retry-step', async () => {
    const cancelCurrentTurn = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' }));
    const requeueIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', retry_attempt: 2 }));
    const retryLastFailedStep = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', retry_attempt: 3 }));
    const clearAutomationFault = vi.fn(async () => ({
      ok: true as const,
      issue_id: 'issue-3',
      status: 'held' as const,
      result_code: 'drain_mode_active',
      message: 'Drain Mode is active',
      dispatch_started: false,
      breaker_cleared: false
    }));
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        cancelCurrentTurn,
        requeueIssue,
        retryLastFailedStep,
        clearAutomationFault,
        resumeBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' })),
        cancelBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' })),
        submitBlockedIssueInput: vi.fn(async () => ({
          ok: true as const,
          issue_id: 'issue-3',
          request_id: 'req-1',
          resume_mode: 'fallback' as const,
          resume_reason_code: 'transport_unsupported',
          requested_at: '2026-05-04T00:00:00.000Z',
          request_lineage: { previous_thread_id: null, previous_session_id: null }
        }))
      }
    });

    await server.listen();
    const address = server.address();
    const cancelResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/cancel-turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops@example.test', reason_note: 'stalled', confirmed: true })
    });
    const requeueResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/requeue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops@example.test', reason_note: 'rerun', confirmed: true })
    });
    const retryResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/retry-step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops@example.test', reason_note: 'retry failed step' })
    });
    const clearFaultResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/clear-automation-fault`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'ops@example.test', reason_note: 'dirty repo fixed' })
    });

    expect(cancelResponse.status).toBe(202);
    expect(requeueResponse.status).toBe(202);
    expect(retryResponse.status).toBe(202);
    expect(clearFaultResponse.status).toBe(200);
    expect(cancelCurrentTurn).toHaveBeenCalledWith('ABC-3', {
      actor: 'ops@example.test',
      confirmed: true,
      reason_note: 'stalled'
    });
    expect(requeueIssue).toHaveBeenCalledWith('ABC-3', {
      actor: 'ops@example.test',
      confirmed: true,
      reason_note: 'rerun'
    });
    expect(retryLastFailedStep).toHaveBeenCalledWith('ABC-3', {
      actor: 'ops@example.test',
      reason_note: 'retry failed step'
    });
    expect(clearAutomationFault).toHaveBeenCalledWith('ABC-3', {
      actor: 'ops@example.test',
      reason_note: 'dirty repo fixed'
    });
  });

  it('rejects missing or blank reason notes before dispatching operator actions', async () => {
    const cancelCurrentTurn = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' }));
    const requeueIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', retry_attempt: 2 }));
    const retryLastFailedStep = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', retry_attempt: 3 }));
    const clearAutomationFault = vi.fn(async () => ({
      ok: true as const,
      issue_id: 'issue-3',
      status: 'held' as const,
      result_code: 'drain_mode_active',
      message: 'Drain Mode is active',
      dispatch_started: false,
      breaker_cleared: false
    }));
    const resumeBlockedIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' }));
    const cancelBlockedIssue = vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' }));
    const submitBlockedIssueInput = vi.fn(async () => ({
      ok: true as const,
      issue_id: 'issue-3',
      request_id: 'req-1',
      resume_mode: 'fallback' as const,
      resume_reason_code: 'transport_unsupported',
      requested_at: '2026-05-04T00:00:00.000Z',
      request_lineage: { previous_thread_id: null, previous_session_id: null }
    }));
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        cancelCurrentTurn,
        requeueIssue,
        retryLastFailedStep,
        clearAutomationFault,
        resumeBlockedIssue,
        cancelBlockedIssue,
        submitBlockedIssueInput
      }
    });

    await server.listen();
    const address = server.address();
    const requests = [
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/cancel-turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      }),
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/requeue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason_note: '   ', confirmed: true })
      }),
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/retry-step`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      }),
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/clear-automation-fault`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      }),
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resume_override_reason: 'operator_override_push_additional_commit' })
      }),
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      }),
      fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: 'req-1', answer: { text: 'continue' } })
      })
    ];
    const responses = await Promise.all(requests);
    const payloads = await Promise.all(responses.map(async (response) => response.json() as Promise<{ error: { code: string } }>));

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400, 400]);
    expect(payloads.map((payload) => payload.error.code)).toEqual([
      'reason_note_required',
      'reason_note_required',
      'reason_note_required',
      'reason_note_required',
      'reason_note_required',
      'reason_note_required',
      'reason_note_required'
    ]);
    expect(cancelCurrentTurn).not.toHaveBeenCalled();
    expect(requeueIssue).not.toHaveBeenCalled();
    expect(retryLastFailedStep).not.toHaveBeenCalled();
    expect(clearAutomationFault).not.toHaveBeenCalled();
    expect(resumeBlockedIssue).not.toHaveBeenCalled();
    expect(cancelBlockedIssue).not.toHaveBeenCalled();
    expect(submitBlockedIssueInput).not.toHaveBeenCalled();
  });

  it('maps unsupported operator transitions to typed conflict envelopes', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        retryLastFailedStep: vi.fn(async () => ({
          ok: false as const,
          code: 'unsupported_transition',
          message: 'Issue ABC-3 has no failed or stalled retry step'
        })),
        resumeBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' })),
        cancelBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' })),
        submitBlockedIssueInput: vi.fn(async () => ({
          ok: true as const,
          issue_id: 'issue-3',
          request_id: 'req-1',
          resume_mode: 'fallback' as const,
          resume_reason_code: 'transport_unsupported',
          requested_at: '2026-05-04T00:00:00.000Z',
          request_lineage: { previous_thread_id: null, previous_session_id: null }
        }))
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/retry-step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason_note: 'try anyway' })
    });
    const payload = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe('unsupported_transition');
  });

  it('accepts blocked input submit requests and resumes issue', async () => {
    const submitBlockedIssueInput = vi.fn(async () => ({
      ok: true as const,
      issue_id: 'issue-3',
      request_id: 'req-42',
      resume_mode: 'fallback' as const,
      resume_reason_code: 'transport_unsupported',
      requested_at: '2026-05-04T00:00:00.000Z',
      request_lineage: { previous_thread_id: 'thread-1', previous_session_id: 'session-1' }
    }));
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        resumeBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' })),
        cancelBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' })),
        submitBlockedIssueInput
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: 'req-42',
        actor: 'ops@example.test',
        reason_note: 'continue with answer',
        answer: { question_id: 'q-1', option_label: 'Continue' }
      })
    });
    const payload = (await response.json()) as {
      resumed: boolean;
      issue_identifier: string;
      request_id: string;
      resume_mode: string;
      resume_reason_code: string;
      request_lineage: { previous_thread_id: string | null; previous_session_id: string | null };
      requested_at: string;
    };

    expect(response.status).toBe(202);
    expect(payload.resumed).toBe(true);
    expect(payload.issue_identifier).toBe('ABC-3');
    expect(payload.request_id).toBe('req-42');
    expect(payload.resume_mode).toBe('fallback');
    expect(payload.resume_reason_code).toBe('transport_unsupported');
    expect(typeof payload.requested_at).toBe('string');
    expect(submitBlockedIssueInput).toHaveBeenCalledWith({
      issueIdentifier: 'ABC-3',
      request_id: 'req-42',
      actor: 'ops@example.test',
      reason_note: 'continue with answer',
      answer: { question_id: 'q-1', option_label: 'Continue' }
    });
  });

  it('returns 400 envelope when blocked input submit payload is invalid', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        resumeBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' })),
        cancelBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' })),
        submitBlockedIssueInput: vi.fn(async () => ({
          ok: true as const,
          issue_id: 'issue-3',
          request_id: 'req-1',
          resume_mode: 'fallback' as const,
          resume_reason_code: 'transport_unsupported',
          requested_at: '2026-05-04T00:00:00.000Z',
          request_lineage: { previous_thread_id: null, previous_session_id: null }
        }))
      }
    });

    await server.listen();
    const address = server.address();

    const invalidJsonResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    });
    const invalidJsonPayload = (await invalidJsonResponse.json()) as { error: { code: string } };
    expect(invalidJsonResponse.status).toBe(400);
    expect(invalidJsonPayload.error.code).toBe('invalid_input_submit');

    const missingFieldsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: 'req-42' })
    });
    const missingFieldsPayload = (await missingFieldsResponse.json()) as { error: { code: string } };
    expect(missingFieldsResponse.status).toBe(400);
    expect(missingFieldsPayload.error.code).toBe('invalid_input_submit');
  });

  it('maps blocked input submit validation failures to 422 envelope', async () => {
    server = new LocalApiServer({
      snapshotSource: {
        getStateSnapshot: () => makeState()
      },
      refreshSource: {
        tick: vi.fn(async () => undefined)
      },
      issueControlSource: {
        resumeBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3' })),
        cancelBlockedIssue: vi.fn(async () => ({ ok: true as const, issue_id: 'issue-3', moved_to_state: 'Todo' })),
        submitBlockedIssueInput: vi.fn(async () => ({
          ok: false as const,
          code: 'invalid_answer',
          message: 'Answer payload is invalid for pending request schema'
        }))
      }
    });

    await server.listen();
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/issues/ABC-3/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_id: 'req-42',
        reason_note: 'answer request',
        answer: { text: '' }
      })
    });
    const payload = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(422);
    expect(payload.error.code).toBe('invalid_answer');
  });
});
