import { expect, test } from '@playwright/test';

type DashboardStatePayload = {
  generated_at: string;
  counts: {
    running: number;
    retrying: number;
    blocked: number;
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
    counts: {
      running: 0,
      retrying: 0,
      blocked: 0
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
    let stateCallCount = 0;
    await installDashboardApiMocks(page, {
      state: () => {
        stateCallCount += 1;
        if (stateCallCount === 1) {
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
});
