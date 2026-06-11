#!/usr/bin/env node
// Boot LocalApiServer with a synthetic OrchestratorState that contains running
// and blocked entries, then capture live-route evidence at five viewports plus
// a 20-second motion video proving orbit phase continuity through a real
// /api/v1/refresh tick.
//
// Output: output/playwright/living-agent-lens/live-focused-*.png and
// live-motion-*.webm (output/playwright/ is intentionally gitignored — see
// docs/analysis/living-agent-lens-evidence.md for the regeneration recipe).
//
// Usage: node scripts/capture-live-lens-evidence.js [port]

const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'output/playwright/living-agent-lens');

// Use the built dist so we exercise the same code path that `npm run
// start:dashboard` does, including the wired /lens routes.
const { LocalApiServer } = require(path.join(root, 'dist/src/api'));

const NOW = Date.parse('2026-06-09T20:41:28.000Z');

function makeIssue(overrides = {}) {
  return {
    id: 'issue-300',
    identifier: 'NIE-300',
    title: 'Chatty',
    description: null,
    priority: 1,
    state: 'In Progress',
    branch_name: 'feature/NIE-300',
    url: 'https://linear.app/issue/NIE-300',
    labels: [],
    blocked_by: [],
    created_at: new Date(NOW - 86400000),
    updated_at: new Date(NOW - 600000),
    ...overrides
  };
}

function makeRunningEntry(overrides = {}) {
  return {
    issue: makeIssue(),
    identifier: 'NIE-300',
    run_id: 'run-300',
    worker_handle: {},
    monitor_handle: {},
    retry_attempt: 0,
    workspace_path: '/tmp/symphony/NIE-300',
    provisioner_type: 'none',
    branch_name: 'feature/NIE-300',
    repo_root: null,
    workspace_exists: true,
    workspace_git_status: 'clean',
    workspace_provisioned: true,
    workspace_is_git_worktree: false,
    session_id: 'session-300',
    thread_id: 'thread_01JX7',
    turn_id: 'turn-3',
    codex_app_server_pid: '12345',
    turn_count: 2,
    last_event: 'codex.turn_completed',
    last_event_summary: 'codex turn completed: continue investigation',
    // Until the snapshot service projects the tracker issue title onto the
    // running entry (see missing_capability `tracker_title_projection`), the
    // focus crown reads from last_message. Use a short heading-like message
    // so the crown stays readable in the evidence capture.
    last_message: 'Chatty · continuing transcript analysis',
    awaiting_input_since_ms: null,
    pending_input_preview: null,
    stalled_waiting_since_ms: null,
    stalled_waiting_reason: null,
    tokens: { input_tokens: 1200, output_tokens: 540, total_tokens: 1740, model_context_window: 200 },
    last_reported_tokens: { input_tokens: 1200, output_tokens: 540, total_tokens: 1740 },
    token_telemetry_status: 'available',
    token_telemetry_last_source: 'terminal_turn_summary',
    token_telemetry_last_at_ms: NOW - 30000,
    token_telemetry_turn_started_at_ms: NOW - 90000,
    token_telemetry_warning_emitted: false,
    recent_events: [
      { at_ms: NOW - 16000, event: 'codex.turn_completed', message: 'turn complete' },
      { at_ms: NOW - 23000, event: 'tool.git', message: 'pushed branch' },
      { at_ms: NOW - 30000, event: 'tool.tests', message: 'ran fast suite' },
      { at_ms: NOW - 41000, event: 'tool.build', message: 'built artifact' },
      { at_ms: NOW - 47000, event: 'tool.linear', message: 'updated tracker' }
    ],
    started_at_ms: NOW - 600000,
    last_codex_timestamp_ms: NOW - 16000,
    ...overrides
  };
}

function makeBlockedEntry(overrides = {}) {
  return {
    issue_id: 'issue-312',
    issue_identifier: 'NIE-312',
    attempt: 1,
    blocked_at_ms: NOW - 1500000,
    stop_reason_code: 'awaiting_human_review_scope_incomplete',
    stop_reason_detail: 'Awaiting human review',
    worker_host: null,
    workspace_path: '/tmp/symphony/NIE-312',
    branch_name: 'feature/NIE-312',
    provisioner_type: 'none',
    repo_root: null,
    workspace_exists: true,
    workspace_git_status: 'clean',
    workspace_provisioned: true,
    workspace_is_git_worktree: false,
    conflict_files: [],
    resolution_hints: [],
    previous_thread_id: 'thread-312',
    previous_session_id: 'session-312',
    requires_manual_resume: true,
    awaiting_operator: true,
    awaiting_operator_reason_code: 'awaiting_human_review_scope_incomplete',
    awaiting_operator_since_ms: NOW - 1500000,
    awaiting_operator_resume_nonce: 1,
    runtime_state_kind: 'blocked_input',
    pending_input: null,
    resume_history: [],
    session_console: [],
    ...overrides
  };
}

function makeBlockedInputEntry(overrides = {}) {
  return makeBlockedEntry({
    issue_id: 'issue-321',
    issue_identifier: 'NIE-321',
    pending_input: {
      request_id: 'req-321-abc',
      request_method: 'operator.input',
      prompt_text: 'Approve the budget rollout for the next worker?',
      questions: [{ id: 'q1', prompt: 'Approve?', options: [{ label: 'yes' }, { label: 'no' }] }],
      input_schema_type: 'options',
      input_required_at_ms: NOW - 120000
    },
    ...overrides
  });
}

function makeRetryEntry(overrides = {}) {
  return {
    issue_id: 'issue-304',
    issue_identifier: 'NIE-304',
    attempt: 2,
    due_at_ms: NOW - 60000,
    overdue_ms: 60000,
    retry_wait_ms: 30000,
    due_state: 'overdue',
    retry_cause: {
      reason_code: 'tool_failure',
      detail: 'lint tool returned non-zero',
      operator_detail: null,
      headline: 'Lint failed; will retry after backoff',
      expected_transition: 'retry',
      last_phase: null
    },
    error: 'Tool failure',
    worker_host: null,
    workspace_path: '/tmp/symphony/NIE-304',
    provisioner_type: 'none',
    branch_name: 'feature/NIE-304',
    repo_root: null,
    workspace_exists: true,
    workspace_git_status: 'clean',
    workspace_provisioned: true,
    workspace_is_git_worktree: false,
    stop_reason_code: 'tool_failure',
    stop_reason_detail: null,
    previous_thread_id: 'thread-304',
    previous_session_id: 'session-304',
    last_phase: null,
    last_phase_at_ms: null,
    last_phase_detail: null,
    ...overrides
  };
}

function makeState() {
  return {
    poll_interval_ms: 30000,
    max_concurrent_agents: 10,
    running: new Map([['issue-300', makeRunningEntry()]]),
    claimed: new Set(['issue-300']),
    retry_attempts: new Map([['issue-304', makeRetryEntry()]]),
    blocked_inputs: new Map([
      ['issue-312', makeBlockedEntry()],
      ['issue-321', makeBlockedInputEntry()]
    ]),
    circuit_breakers: new Map(),
    budget_usage_samples: new Map(),
    completed: new Set(),
    codex_totals: { input_tokens: 12000, output_tokens: 5400, total_tokens: 17400, seconds_running: 600 },
    codex_rate_limits: null,
    health: { dispatch_validation: 'ok', last_error: null },
    drain_mode: { active: false, entered_at_ms: null, updated_at_ms: null, reason: null },
    quiescence: {
      safe_to_shutdown: true,
      state: 'safe',
      updated_at_ms: NOW,
      blockers: [],
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
      warnings: [],
      restart_guidance: {
        safe_to_restart: false,
        recommended_action: 'drain',
        pending_work: ['active runs'],
        detail: 'Active runs in flight; drain before restart.'
      }
    },
    runtime_identity: null,
    throughput: {
      current_tps: 0.12,
      avg_tps_60s: 0.18,
      window_seconds: 600,
      sparkline_10m: Array.from({ length: 24 }, (_, i) => 0.1 + (i % 4) * 0.05),
      sample_count: 24
    },
    recent_runtime_events: [
      { at_ms: NOW - 16000, event: 'codex.turn_completed', severity: 'info', issue_identifier: 'NIE-300', detail: 'turn complete' },
      { at_ms: NOW - 23000, event: 'tool.git', severity: 'info', issue_identifier: 'NIE-300', detail: 'pushed branch' },
      { at_ms: NOW - 30000, event: 'tool.tests', severity: 'info', issue_identifier: 'NIE-300', detail: 'fast suite' },
      { at_ms: NOW - 41000, event: 'tool.build', severity: 'info', issue_identifier: 'NIE-300', detail: 'built' },
      { at_ms: NOW - 47000, event: 'tool.linear', severity: 'info', issue_identifier: 'NIE-300', detail: 'updated tracker' }
    ]
  };
}

function makeDiagnosticsSource() {
  return {
    getActiveProfile: () => ({
      name: 'strict',
      approval_policy: 'never',
      thread_sandbox: 'workspace-write',
      turn_sandbox_policy: { type: 'workspace' },
      user_input_policy: 'fail_attempt'
    }),
    getPersistenceHealth: () => ({
      enabled: true,
      db_path: '/tmp/runtime.sqlite',
      retention_days: 365,
      run_count: 12,
      last_pruned_at: null,
      last_prune_failure_at: null,
      last_prune_failure_reason: null,
      last_prune_failure_detail: null,
      integrity_ok: true
    }),
    getLoggingHealth: () => ({ root: '/tmp/log', active_file: '/tmp/log/symphony.log', rotation: { max_bytes: 1e7, max_files: 5 }, sinks: ['stderr'] }),
    listRunHistory: () => [],
    getUiState: () => null,
    setUiState: () => undefined,
    getPromptFallbackActive: () => false,
    getRuntimeResolution: () => ({
      workflow_path: '/tmp/WORKFLOW.md',
      workflow_dir: '/tmp',
      workspace_root: '/tmp/workspaces',
      workspace_root_source: 'workflow',
      server: { host: '127.0.0.1', port: 3000 },
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
      enabled: false, include_file: '/tmp/.worktreeinclude', from: 'repo_root', conflict_policy: 'skip',
      require_gitignored: false, max_files: 0, max_total_bytes: 0, last_status: null, last_error_code: null,
      last_error_message: null, source_path: null, copied_files: 0, skipped_existing: 0, blocked_files: 0,
      bytes_copied: 0, duration_ms: 0
    })
  };
}

function stamp() {
  const d = new Date();
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  let tickCount = 0;
  const refreshSource = {
    tick: async () => {
      tickCount += 1;
      return undefined;
    }
  };

  const server = new LocalApiServer({
    snapshotSource: {
      getStateSnapshot: (...args) => {
        try {
          return makeState();
        } catch (err) {
          console.error('snapshotSource threw:', err);
          throw err;
        }
      }
    },
    refreshSource,
    diagnosticsSource: makeDiagnosticsSource(),
    logger: {
      log: (entry) => {
        if (entry.level === 'warn' || entry.level === 'error') {
          console.error(`[server:${entry.level}]`, entry.event, entry.message, entry.context ?? '');
        }
      }
    },
    dashboardConfig: {
      dashboard_enabled: true,
      refresh_ms: 4000,
      render_interval_ms: 1000,
      asset_revision: 'live-evidence'
    }
  });

  await server.listen();
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Server listening on ${baseUrl}`);

  // Sanity-probe the lens API to make sure the synthetic state projects.
  const probe = await fetch(`${baseUrl}/api/v1/living-agent-lens?focus_issue=NIE-300`);
  const probeJson = await probe.json();
  console.log(
    `Probe: ${probe.status} queue=${probeJson.queue?.length ?? 0} focus=${probeJson.focus?.issue_identifier ?? 'null'} missing=${probeJson.missing_capabilities?.length ?? 0}`
  );
  if (!probeJson.queue || probeJson.queue.length === 0) {
    console.error('Aborting: lens API returned an empty queue. Payload:', JSON.stringify(probeJson).slice(0, 500));
    const stateProbe = await fetch(`${baseUrl}/api/v1/state`);
    const stateJson = await stateProbe.json();
    console.error('State probe:', stateProbe.status, JSON.stringify(stateJson).slice(0, 500));
    process.exit(2);
  }

  const browser = await chromium.launch();
  try {
    const matrix = [
      { slug: 'focused-desktop',         width: 1586, height: 992,  reducedMotion: 'no-preference' },
      { slug: 'focused-medium',          width: 1440, height: 1000, reducedMotion: 'no-preference' },
      { slug: 'focused-small',           width: 1280, height: 900,  reducedMotion: 'no-preference' },
      { slug: 'focused-mobile',          width: 680,  height: 1000, reducedMotion: 'no-preference' },
      { slug: 'focused-reduced-motion',  width: 1586, height: 992,  reducedMotion: 'reduce' }
    ];
    for (const frame of matrix) {
      const ctx = await browser.newContext({
        viewport: { width: frame.width, height: frame.height },
        deviceScaleFactor: 2,
        reducedMotion: frame.reducedMotion
      });
      const page = await ctx.newPage();
      page.on('console', (msg) => console.log(`  [page:${frame.slug}:${msg.type()}]`, msg.text()));
      page.on('pageerror', (err) => console.log(`  [page:${frame.slug}:error]`, err.message));
      await page.goto(`${baseUrl}/lens?focus_issue=NIE-300`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.lens-app');
      await page.waitForSelector('[data-issue-row="NIE-300"]', { timeout: 10000 });
      await page.waitForTimeout(1500);
      const file = `live-${stamp()}-${frame.slug}-${frame.width}x${frame.height}.png`;
      await page.screenshot({ path: path.join(outDir, file), fullPage: false });
      console.log(`Wrote ${path.relative(root, path.join(outDir, file))}`);
      await ctx.close();
    }

    // 20-second motion capture proving orbit phase continuity through refresh.
    const videoDir = outDir;
    const motionCtx = await browser.newContext({
      viewport: { width: 1586, height: 992 },
      deviceScaleFactor: 1, // 1x for smaller video files
      recordVideo: { dir: videoDir, size: { width: 1586, height: 992 } }
    });
    const motionPage = await motionCtx.newPage();
    await motionPage.goto(`${baseUrl}/lens?focus_issue=NIE-300`, { waitUntil: 'domcontentloaded' });
    await motionPage.waitForSelector('.lens-app');
    await motionPage.waitForSelector('[data-issue-row="NIE-300"]');
    // 20 seconds total: settle 5s, trigger refresh, observe 15s.
    await motionPage.waitForTimeout(5000);
    await motionPage.evaluate(() =>
      fetch('/api/v1/refresh', { method: 'POST' }).catch(() => undefined)
    );
    await motionPage.waitForTimeout(7000);
    // Click on a different queue row, then back, to prove focus retention.
    await motionPage.locator('[data-issue-row="NIE-312"]').click().catch(() => undefined);
    await motionPage.waitForTimeout(4000);
    await motionPage.locator('[data-issue-row="NIE-300"]').click().catch(() => undefined);
    await motionPage.waitForTimeout(4000);

    const videoPath = motionPage.video() ? await motionPage.video().path() : null;
    await motionCtx.close();
    if (videoPath && fs.existsSync(videoPath)) {
      const targetName = `live-motion-${stamp()}-1586x992.webm`;
      const target = path.join(outDir, targetName);
      fs.renameSync(videoPath, target);
      console.log(`Wrote ${path.relative(root, target)} (${tickCount} refresh ticks observed)`);
    } else {
      console.log('Motion video file was not produced.');
    }
  } finally {
    await browser.close();
    await server.close();
  }
})();
