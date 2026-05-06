import { expect, test } from '@playwright/test';

type DashboardStatePayload = {
  generated_at: string;
  snapshot_generated_at_ms?: number;
  snapshot_age_ms?: number;
  snapshot_freshness_state?: string;
  api_degraded_mode?: boolean;
  api_degraded_reason_code?: string | null;
  api_degraded_routes?: string[];
  counts: {
    running: number;
    retrying: number;
    blocked: number;
    running_stalled_waiting_count: number;
    running_awaiting_input_count: number;
  };
  codex_totals: {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    seconds_running: number;
  };
  rate_limits: Record<string, unknown> | null;
  throughput: {
    windows: Array<Record<string, unknown>>;
    generated_at: string;
  } | null;
  running: Array<Record<string, unknown>>;
  retrying: Array<Record<string, unknown>>;
  blocked: Array<Record<string, unknown>>;
  recent_runtime_events: Array<Record<string, unknown>>;
  health: Record<string, unknown>;
};

type IssuePayload = Record<string, unknown>;

const ISO_NOW = '2026-04-30T10:00:00.000Z';
const ISO_OLD = '2026-04-30T09:58:00.000Z';

function baseState(overrides: Partial<DashboardStatePayload> = {}): DashboardStatePayload {
  return {
    generated_at: ISO_NOW,
    snapshot_generated_at_ms: Date.parse(ISO_NOW),
    snapshot_age_ms: 0,
    snapshot_freshness_state: 'fresh',
    api_degraded_mode: false,
    api_degraded_reason_code: null,
    api_degraded_routes: [],
    counts: {
      running: 0,
      retrying: 0,
      blocked: 0,
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
    throughput: {
      windows: [],
      generated_at: ISO_NOW
    },
    running: [],
    retrying: [],
    blocked: [],
    recent_runtime_events: [],
    health: {
      dispatch_validation: 'ok',
      last_error: null
    },
    ...overrides
  };
}

async function installDashboardApiMocks(
  page: Parameters<typeof test>[0]['page'],
  options: {
    state: DashboardStatePayload | (() => DashboardStatePayload);
    issues?: Record<string, IssuePayload | ((id: string) => IssuePayload)>;
    diagnostics?: Record<string, IssuePayload | ((id: string) => IssuePayload)>;
    onRefresh?: () => void;
  }
): Promise<void> {
  await page.route('**/api/v1/state**', async (route) => {
    const payload = typeof options.state === 'function' ? options.state() : options.state;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload)
    });
  });

  await page.route('**/api/v1/diagnostics**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        logging: { sink: 'stdout' },
        persistence: { integrity_ok: true },
        runtime_resolution: { workspace_root: '/tmp/symphony' },
        phase_markers: { enabled: true, timeline_limit: 30, last_emit_error_code: null }
      })
    });
  });

  await page.route('**/api/v1/history?limit=8', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] })
    });
  });

  await page.route('**/api/v1/ui-state', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ saved: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: null }) });
  });

  await page.route('**/api/v1/refresh', async (route) => {
    options.onRefresh?.();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ queued: true, coalesced: false })
    });
  });

  await page.route('**/api/v1/events**', async (route) => {
    await route.abort();
  });

  await page.route('**/api/v1/issues/*/resume', async (route) => {
    const segments = route.request().url().split('/');
    const issueIdentifier = decodeURIComponent(segments[segments.length - 2] || 'UNKNOWN');
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ issue_identifier: issueIdentifier })
    });
  });

  await page.route('**/api/v1/issues/*/diagnostics', async (route) => {
    const segments = route.request().url().split('/');
    const issueIdentifier = decodeURIComponent(segments[segments.length - 2] || '');
    const diagnosticsResolver = options.diagnostics?.[issueIdentifier];
    if (!diagnosticsResolver) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'thread_diagnostics_not_found', message: 'No diagnostics' } })
      });
      return;
    }
    const payload = typeof diagnosticsResolver === 'function' ? diagnosticsResolver(issueIdentifier) : diagnosticsResolver;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.route('**/api/v1/*', async (route) => {
    const url = new URL(route.request().url());
    const passthrough = new Set([
      '/api/v1/state',
      '/api/v1/diagnostics',
      '/api/v1/history',
      '/api/v1/ui-state',
      '/api/v1/refresh'
    ]);
    if (passthrough.has(url.pathname) || url.pathname.endsWith('/resume')) {
      await route.fallback();
      return;
    }
    const issueIdentifier = decodeURIComponent(url.pathname.split('/').at(-1) || '');
    const issueResolver = options.issues?.[issueIdentifier];

    if (!issueResolver) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Issue not found' } })
      });
      return;
    }

    const payload = typeof issueResolver === 'function' ? issueResolver(issueIdentifier) : issueResolver;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

test.describe('phase-marker dashboard e2e', () => {
  test('running table shows current phase and stale warning metadata', async ({ page }) => {
    await installDashboardApiMocks(page, {
      state: baseState({
        running: [
          {
            issue_identifier: 'NIE-22',
            state: 'running',
            session_id: 'session-running-1',
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-22',
            provisioner_type: 'git_worktree',
            branch_name: 'feature/NIE-22',
            workspace_git_status: 'clean',
            started_at: ISO_OLD,
            turn_count: 4,
            tokens: { total_tokens: 1200, input_tokens: 800, output_tokens: 400 },
            last_event_summary: 'planning update',
            last_event: 'codex.phase.planning',
            last_message: 'Planning complete',
            last_event_at: ISO_NOW,
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            current_phase: 'planning',
            current_phase_at: ISO_OLD,
            phase_elapsed_ms: 120000,
            phase_detail: 'waiting for implementation'
          }
        ]
      })
    });

    await page.goto('/');

    await expect(page.locator('#running-rows')).toContainText('NIE-22');
    await expect(page.locator('#running-rows')).toContainText('planning');
    await expect(page.locator('#running-rows')).toContainText('No phase movement yet');
  });

  test('renders operator explainer counters, row hints, and stalled-wait issue detail card', async ({ page }) => {
    await installDashboardApiMocks(page, {
      state: baseState({
        counts: {
          running: 1,
          retrying: 0,
          blocked: 1,
          running_stalled_waiting_count: 1,
          running_awaiting_input_count: 0
        },
        running: [
          {
            issue_identifier: 'NIE-49',
            state: 'running',
            session_id: 'session-stalled',
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-49',
            provisioner_type: 'git_worktree',
            branch_name: 'feature/NIE-49',
            workspace_git_status: 'clean',
            started_at: ISO_OLD,
            turn_count: 8,
            tokens: { total_tokens: 1200, input_tokens: 800, output_tokens: 400 },
            last_event_summary: 'codex.turn.waiting heartbeat',
            last_event: 'codex.turn.waiting',
            last_message: 'waiting',
            last_event_at: ISO_NOW,
            thread_id: 'thread-stalled',
            turn_id: 'turn-stalled',
            current_phase: 'implementation',
            current_phase_at: ISO_OLD,
            phase_elapsed_ms: 120000,
            phase_detail: 'waiting heartbeat',
            awaiting_input: false,
            progress_signal_state: 'stalled_waiting',
            stalled_waiting: true,
            stalled_waiting_since_ms: Date.parse('2026-04-30T09:59:00.000Z'),
            stalled_waiting_reason: 'turn_waiting_threshold_exceeded',
            operator_explainer_hint: {
              classification: 'stalled_waiting',
              actionability: 'required',
              headline: 'Run is alive but waiting too long'
            }
          }
        ],
        blocked: [
          {
            issue_identifier: 'NIE-50',
            attempt: 1,
            blocked_at: ISO_NOW,
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-50',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'turn_input_required',
            stop_reason_detail: 'operator input required',
            previous_session_id: 'session-prev-blocked',
            previous_thread_id: 'thread-prev-blocked',
            operator_explainer_hint: {
              classification: 'blocked_input',
              actionability: 'required',
              headline: 'Run is blocked on operator input'
            }
          }
        ]
      }),
      issues: {
        'NIE-49': {
          issue_identifier: 'NIE-49',
          issue_id: 'issue-nie-49',
          status: 'running',
          operator_explainer: {
            version: '2026-05-05.v1',
            classification: 'stalled_waiting',
            actionability: 'required',
            headline: 'Run is alive but waiting too long',
            detail: 'The run is still alive through codex.turn.waiting heartbeats after the configured wait threshold.',
            recommended_actions: ['Inspect recent events and decide whether to resume/cancel/restart'],
            expected_transition: null,
            reason_code: 'turn_waiting_threshold_exceeded',
            reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold'
          },
          workspace: { path: '/tmp/workspaces/NIE-49' },
          running: {
            current_phase: 'implementation',
            provisioner_type: 'git_worktree',
            branch_name: 'feature/NIE-49',
            workspace_git_status: 'clean',
            workspace_provisioned: true,
            workspace_is_git_worktree: true
          },
          retry: null,
          blocked: null,
          phase_timeline: [],
          recent_events: [
            {
              at: ISO_NOW,
              event: 'codex.turn.waiting',
              message: 'waiting'
            }
          ]
        }
      }
    });

    await page.goto('/');

    const stalledStateCell = page.locator('tr[data-issue="NIE-49"] td').nth(1);
    await expect(stalledStateCell).toContainText('Stalled Waiting');
    await expect(stalledStateCell).toContainText('Run is alive but waiting too long');
    await expect.poll(async () => (await stalledStateCell.textContent())?.match(/Stalled Waiting/g)?.length ?? 0).toBe(1);
    await expect
      .poll(async () => (await stalledStateCell.textContent())?.match(/Run is alive but waiting too long/g)?.length ?? 0)
      .toBe(1);

    await expect(page.locator('#kpi-grid')).toContainText('Stalled Waiting');
    await expect(page.locator('#kpi-grid')).toContainText('Awaiting Input');
    await expect(page.locator('#running-rows')).toContainText('Run is alive but waiting too long');
    await expect(page.locator('#blocked-rows')).toContainText('Run is blocked on operator input');

    await page.locator('#issue-input').fill('NIE-49');
    await page.getByRole('button', { name: 'Load' }).click();

    await expect(page.locator('#issue-explainer-card')).toContainText('Run is alive but waiting too long');
    await expect(page.locator('#issue-explainer-card')).toContainText('required');
    await expect(page.locator('#issue-explainer-card')).toContainText('Inspect recent events and decide whether to resume/cancel/restart');
    await expect(page.locator('#issue-summary')).toContainText('Actionability: required');
  });

  test('running row links open diagnostics drilldown with timeline lanes and blocker intelligence', async ({ page }) => {
    await installDashboardApiMocks(page, {
      state: baseState({
        running: [
          {
            issue_identifier: 'NIE-57',
            state: 'running',
            session_id: 'session-drilldown',
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-57',
            provisioner_type: 'git_worktree',
            branch_name: 'feature/NIE-57',
            workspace_git_status: 'clean',
            started_at: ISO_OLD,
            turn_count: 5,
            tokens: { total_tokens: 3000, input_tokens: 2200, output_tokens: 800 },
            last_event_summary: 'codex.turn.waiting heartbeat',
            last_event: 'codex.turn.waiting',
            last_message: 'waiting',
            last_event_at: ISO_NOW,
            thread_id: 'thread-drilldown',
            turn_id: 'turn-drilldown',
            current_phase: 'implementation',
            current_phase_at: ISO_OLD,
            phase_elapsed_ms: 120000,
            phase_detail: 'tool wait',
            current_blocker_class: 'stalled_waiting',
            time_since_progress: 90000,
            last_successful_step: 'codex.turn.started: implementation turn started'
          }
        ]
      }),
      issues: {
        'NIE-57': {
          issue_identifier: 'NIE-57',
          issue_id: 'issue-nie-57',
          status: 'running',
          workspace: { path: '/tmp/workspaces/NIE-57' },
          running: { current_phase: 'implementation' },
          retry: null,
          blocked: null,
          phase_timeline: [],
          recent_events: []
        }
      },
      diagnostics: {
        'NIE-57': {
          thread_id: 'thread-drilldown',
          issue_identifier: 'NIE-57',
          attempt: 0,
          status: 'stalled',
          timeline: [
            {
              at_ms: Date.parse('2026-04-30T09:58:30.000Z'),
              event: 'codex.turn.started',
              reason_code: null,
              reason_detail: 'implementation turn started',
              thread_id: 'thread-drilldown',
              turn_id: 'turn-drilldown',
              session_id: 'session-drilldown'
            },
            {
              at_ms: Date.parse('2026-04-30T09:59:30.000Z'),
              event: 'codex.turn.waiting',
              reason_code: 'turn_waiting_threshold_exceeded',
              reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold',
              thread_id: 'thread-drilldown',
              turn_id: 'turn-drilldown',
              session_id: 'session-drilldown'
            }
          ],
          phase_spans: [
            {
              phase: 'implementation',
              started_at_ms: Date.parse('2026-04-30T09:58:00.000Z'),
              ended_at_ms: null,
              duration_ms: null,
              status: 'running',
              reason_code: null,
              reason_detail: 'tool wait'
            }
          ],
          tool_spans: [
            {
              tool_name: 'exec_command',
              started_at_ms: Date.parse('2026-04-30T09:59:00.000Z'),
              ended_at_ms: null,
              duration_ms: null,
              status: 'running',
              reason_code: 'turn_waiting_threshold_exceeded',
              reason_detail: 'shell command still running'
            }
          ],
          wait_spans: [
            {
              started_at_ms: Date.parse('2026-04-30T09:59:30.000Z'),
              ended_at_ms: null,
              duration_ms: null,
              status: 'blocked',
              reason_code: 'turn_waiting_threshold_exceeded',
              reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold'
            }
          ],
          current_blocker: {
            classification: 'tool_waiting_long',
            reason_code: 'turn_waiting_threshold_exceeded',
            reason_detail: 'codex.turn.waiting heartbeat loop exceeded threshold',
            time_since_progress: 90000,
            actionability: 'recommended',
            recommended_actions: ['Inspect the active Codex turn and resume, cancel, or retry the run if the wait is not expected.'],
            expected_auto_transition: null
          },
          last_meaningful_progress_at_ms: Date.parse('2026-04-30T09:58:30.000Z')
        }
      }
    });

    await page.goto('/');

    await expect(page.locator('#running-rows')).toContainText('stalled_waiting');
    await expect(page.locator('#running-rows')).toContainText('90000 ms');
    await expect(page.locator('#running-rows')).toContainText('codex.turn.started: implementation turn started');

    await page.locator('#running-rows a', { hasText: 'NIE-57' }).click();

    await expect(page.locator('#thread-detail')).toBeVisible();
    await expect(page.locator('#thread-timeline-lanes')).toContainText('Phase');
    await expect(page.locator('#thread-timeline-lanes')).toContainText('implementation');
    await expect(page.locator('#thread-timeline-lanes')).toContainText('Tool');
    await expect(page.locator('#thread-timeline-lanes')).toContainText('exec_command');
    await expect(page.locator('#thread-timeline-lanes')).toContainText('Wait');
    await expect(page.locator('#thread-blocker-card')).toContainText('tool_waiting_long');
    await expect(page.locator('#thread-blocker-card')).toContainText('turn_waiting_threshold_exceeded');
    await expect(page.locator('#thread-blocker-card')).toContainText('90000');
    await expect(page.locator('#thread-blocker-card')).toContainText('Inspect the active Codex turn');
    await expect(page.locator('#thread-raw-events')).toContainText('codex.turn.waiting');
  });

  test('retrying and blocked views show last_phase context', async ({ page }) => {
    await installDashboardApiMocks(page, {
      state: baseState({
        retrying: [
          {
            issue_identifier: 'NIE-23',
            attempt: 2,
            due_at: ISO_NOW,
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-23',
            provisioner_type: 'git_worktree',
            branch_name: 'feature/NIE-23',
            workspace_git_status: 'dirty',
            workspace_exists: true,
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'retryable_error',
            stop_reason_detail: 'network glitch',
            previous_session_id: 'session-prev-retry',
            previous_thread_id: 'thread-prev-retry',
            error: 'timeout',
            last_phase: 'implementation',
            last_phase_at: ISO_OLD,
            last_phase_detail: 'tool call failed'
          }
        ],
        blocked: [
          {
            issue_identifier: 'NIE-24',
            attempt: 1,
            blocked_at: ISO_NOW,
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-24',
            workspace_provisioned: true,
            workspace_is_git_worktree: true,
            stop_reason_code: 'blocked_input',
            stop_reason_detail: 'needs approval',
            previous_session_id: 'session-prev-blocked',
            previous_thread_id: 'thread-prev-blocked',
            last_phase: 'validation',
            last_phase_at: ISO_OLD,
            last_phase_detail: 'awaiting operator response'
          }
        ]
      })
    });

    await page.goto('/');

    await expect(page.locator('#retry-rows')).toContainText('Last phase: implementation');
    await expect(page.locator('#retry-rows')).toContainText('tool call failed');
    await expect(page.locator('#blocked-rows')).toContainText('Last phase: validation');
    await expect(page.locator('#blocked-rows')).toContainText('awaiting operator response');
  });

  test('issue detail renders phase timeline and preserves context across transition', async ({ page }) => {
    let scenario: 'running' | 'retrying' = 'running';
    await installDashboardApiMocks(page, {
      state: () => {
        if (scenario === 'running') {
          return baseState({
            running: [
              {
                issue_identifier: 'NIE-25',
                state: 'running',
                session_id: 'session-transition-1',
                worker_host: 'hessian',
                workspace_path: '/tmp/workspaces/NIE-25',
                provisioner_type: 'git_worktree',
                branch_name: 'feature/NIE-25',
                workspace_git_status: 'clean',
                started_at: ISO_OLD,
                turn_count: 1,
                tokens: { total_tokens: 100, input_tokens: 60, output_tokens: 40 },
                last_event_summary: 'planning',
                last_event: 'codex.phase.planning',
                last_message: 'planning',
                last_event_at: ISO_NOW,
                thread_id: 'thread-transition',
                turn_id: 'turn-transition',
                current_phase: 'planning',
                current_phase_at: ISO_NOW,
                phase_elapsed_ms: 1000,
                phase_detail: 'plan created'
              }
            ]
          });
        }

        return baseState({
          running: [],
          retrying: [
            {
              issue_identifier: 'NIE-25',
              attempt: 2,
              due_at: ISO_NOW,
              worker_host: 'hessian',
              workspace_path: '/tmp/workspaces/NIE-25',
              provisioner_type: 'git_worktree',
              branch_name: 'feature/NIE-25',
              workspace_git_status: 'clean',
              workspace_exists: true,
              workspace_provisioned: true,
              workspace_is_git_worktree: true,
              stop_reason_code: 'retryable_error',
              stop_reason_detail: 'transient failure',
              previous_session_id: 'session-transition-1',
              previous_thread_id: 'thread-transition',
              error: 'timeout',
              last_phase: 'implementation',
              last_phase_at: ISO_NOW,
              last_phase_detail: 'call external tool'
            }
          ]
        });
      },
      onRefresh: () => {
        scenario = 'retrying';
      },
      issues: {
        'NIE-25': {
          issue_identifier: 'NIE-25',
          status: 'retrying',
          workspace: { path: '/tmp/workspaces/NIE-25' },
          retry: {
            stop_reason_code: 'retryable_error',
            previous_session_id: 'session-transition-1',
            last_phase: 'implementation',
            last_phase_at: ISO_NOW,
            last_phase_detail: 'call external tool'
          },
          blocked: null,
          running: null,
          phase_timeline: [
            {
              at: '2026-04-30T09:59:00.000Z',
              phase: 'planning',
              attempt: 1,
              detail: 'plan created',
              thread_id: 'thread-transition',
              session_id: 'session-transition-1'
            },
            {
              at: '2026-04-30T09:59:30.000Z',
              phase: 'implementation',
              attempt: 1,
              detail: 'call external tool',
              thread_id: 'thread-transition',
              session_id: 'session-transition-1'
            }
          ]
        }
      }
    });

    await page.goto('/');

    await expect(page.locator('#running-rows')).toContainText('NIE-25');

    await page.getByRole('button', { name: 'Refresh Now' }).click();

    await expect(page.locator('#retry-rows')).toContainText('NIE-25');
    await expect(page.locator('#retry-rows')).toContainText('Last phase: implementation');

    await page.locator('#issue-input').fill('NIE-25');
    await page.getByRole('button', { name: 'Load' }).click();

    await expect(page.locator('#issue-summary')).toContainText('Last phase before stop: implementation');
    await expect(page.locator('#issue-output')).toContainText('Execution Timeline');
    await expect(page.locator('#issue-output')).toContainText('planning');
    await expect(page.locator('#issue-output')).toContainText('implementation');
  });

  test('visibility badges render turn control, progress quality, token confidence, degraded banner, freshness, and action trail', async ({ page }) => {
    await installDashboardApiMocks(page, {
      state: baseState({
        api_degraded_mode: true,
        api_degraded_reason_code: 'route_not_found',
        api_degraded_routes: ['/api/v1/issues/:issue_identifier'],
        running: [
          {
            issue_identifier: 'NIE-53',
            state: 'running',
            session_id: 'session-visibility-1',
            worker_host: 'hessian',
            workspace_path: '/tmp/workspaces/NIE-53',
            started_at: ISO_OLD,
            turn_count: 2,
            tokens: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
            token_telemetry_status: 'unavailable',
            token_telemetry_confidence: 'missing',
            token_telemetry_source: null,
            last_event_summary: 'codex turn waiting',
            last_event: 'codex.turn.waiting',
            last_message: 'waiting',
            last_event_at: ISO_NOW,
            thread_id: 'thread-visibility',
            turn_id: 'turn-visibility',
            current_phase: 'planning',
            current_phase_at: ISO_OLD,
            phase_elapsed_ms: 120000,
            turn_control_state: 'operator_turn',
            turn_control_reason_code: 'turn_input_required',
            turn_control_since_ms: Date.parse(ISO_OLD),
            progress_signal_state: 'heartbeat_only',
            last_progress_transition_at_ms: Date.parse(ISO_OLD),
            last_heartbeat_at_ms: Date.parse(ISO_NOW),
            not_blocked_explainer_code: 'within_wait_threshold',
            not_blocked_explainer_text: 'The run is emitting waiting heartbeats and remains within the configured blocked-transition threshold.',
            operator_actions: [
              {
                action: 'submit_input',
                requested_at_ms: Date.parse(ISO_NOW),
                result: 'rejected',
                result_code: 'input_submission_invalid',
                message: 'invalid answer'
              }
            ]
          }
        ]
      }),
      issues: {
        'NIE-53': {
          issue_identifier: 'NIE-53',
          status: 'running',
          snapshot_generated_at_ms: Date.parse(ISO_NOW),
          snapshot_age_ms: 0,
          snapshot_freshness_state: 'fresh',
          api_degraded_mode: true,
          api_degraded_reason_code: 'route_not_found',
          workspace: { path: '/tmp/workspaces/NIE-53' },
          running: {
            current_phase: 'planning',
            turn_control_state: 'operator_turn',
            progress_signal_state: 'heartbeat_only',
            token_telemetry_confidence: 'missing',
            not_blocked_explainer_text: 'The run is emitting waiting heartbeats and remains within the configured blocked-transition threshold.'
          },
          retry: null,
          blocked: null,
          operator_actions: [
            {
              action: 'submit_input',
              requested_at_ms: Date.parse(ISO_NOW),
              result: 'rejected',
              result_code: 'input_submission_invalid',
              message: 'invalid answer'
            }
          ],
          phase_timeline: [],
          recent_events: []
        }
      }
    });

    await page.goto('/');

    await expect(page.locator('#last-updated')).toContainText('fresh');
    await expect(page.locator('#api-degraded-banner')).toContainText('route_not_found');
    await expect(page.locator('#running-rows')).toContainText('Operator Turn');
    await expect(page.locator('#running-rows')).toContainText('Heartbeat Only');
    await expect(page.locator('#running-rows')).toContainText('Missing telemetry');
    await expect(page.locator('#running-rows')).toContainText('Why not blocked:');
    await expect(page.locator('#running-rows')).toContainText('Last action: submit_input rejected');

    await page.locator('#issue-input').fill('NIE-53');
    await page.getByRole('button', { name: 'Load' }).click();

    await expect(page.locator('#issue-summary')).toContainText('API degraded: route_not_found');
    await expect(page.locator('#issue-summary')).toContainText('Turn control: Operator Turn');
    await expect(page.locator('#issue-output')).toContainText('Operator Action Outcomes');
    await expect(page.locator('#issue-output')).toContainText('submit_input');
  });
});
