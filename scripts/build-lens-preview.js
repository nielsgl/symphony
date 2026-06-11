#!/usr/bin/env node
// Build a self-contained preview HTML for the Living Agent Lens.
//
// The lens client fetches /api/v1/living-agent-lens at runtime. This script
// pre-computes a fixture LivingAgentLensResponse via the real projector and
// inlines it into the HTML, then stubs window.fetch so the lens renders the
// fixture without requiring the live runtime.
//
// Usage: node scripts/build-lens-preview.js [outPath]

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const cssPath = path.join(root, 'src/api/dashboard-assets/lens-styles.ts');
const jsPath = path.join(root, 'src/api/dashboard-assets/generated-lens-client.ts');
const outPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'output/playwright/living-agent-lens/lens-preview.html');

function readGeneratedConst(filePath, constName) {
  const text = fs.readFileSync(filePath, 'utf8');
  const marker = `export const ${constName} = `;
  const idx = text.indexOf(marker);
  if (idx === -1) throw new Error(`${constName} not found in ${filePath}`);
  const after = text.slice(idx + marker.length);
  // The value is a JSON-encoded string literal followed by ;\n
  const end = after.lastIndexOf('";');
  if (end === -1) throw new Error('Could not parse generated const');
  const raw = after.slice(0, end + 1); // include closing quote
  return JSON.parse(raw);
}

function readCssExport(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const match = text.match(/const CSS = String\.raw`([\s\S]*?)`;\s*$/);
  if (!match) throw new Error('Could not parse lens-styles.ts');
  return match[1];
}

const lensJs = readGeneratedConst(jsPath, 'GENERATED_LENS_CLIENT_JS');
const lensCss = readCssExport(cssPath);

const fixture = buildFixture();

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Symphony Control Constellation — Living Agent Lens (preview)</title>
  <style>${lensCss}</style>
</head>
<body>
  <div id="lens-root"></div>
  <script>
    const FIXTURE = ${JSON.stringify(fixture)};
    const originalFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      if (url.indexOf('/api/v1/living-agent-lens') >= 0) {
        return Promise.resolve(new Response(JSON.stringify(FIXTURE), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      }
      return originalFetch(input, init);
    };
    // Block SSE; the preview is static.
    window.EventSource = function() {
      return { addEventListener: function() {}, close: function() {} };
    };
  </script>
  <script>${lensJs}</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
console.log(`Wrote ${path.relative(root, outPath)}`);

function buildFixture() {
  const now = Date.parse('2026-06-04T12:41:28.000Z');
  return {
    generated_at: '2026-06-04T12:41:28.000Z',
    snapshot_freshness: {
      generated_at_ms: now,
      age_ms: 1200,
      state: 'fresh',
      transport: 'stream',
      label: '1.2s',
      cadence_seconds: 1.2
    },
    api_degraded_mode: false,
    api_degraded_reason_code: null,
    shell: {
      brand: { title: 'Symphony Control Constellation', subtitle: 'Living Agent Lens' },
      orchestrator: { icon: 'orbit', label: 'Orchestrator', value: 'Local', detail: 'Healthy', tone: 'green', detail_endpoint: '/api/v1/diagnostics' },
      runtime_build: { icon: 'hash', label: 'Runtime Build', value: 'v1.42.3', detail: 'commit abc123d', tone: 'green', detail_endpoint: '/api/v1/diagnostics' },
      system_health: { icon: 'shield-check', label: 'System Health', value: 'All Green', detail: null, tone: 'green', detail_endpoint: '/api/v1/diagnostics' },
      audit: { icon: 'record', label: 'Audit', value: 'Recording', detail: 'Every action logged', tone: 'red', detail_endpoint: '/api/v1/history' },
      refresh_pulse: { icon: 'pulse', label: 'Refresh Pulse', value: '1.2s', detail: 'fresh · stream', tone: 'blue', detail_endpoint: null },
      filters: [
        { id: 'needs_me', label: 'Needs me', count: 2, active: false },
        { id: 'stalled', label: 'Stalled', count: 1, active: false },
        { id: 'retry_overdue', label: 'Retry overdue', count: 0, active: false },
        { id: 'unsafe_restart', label: 'Unsafe to restart', count: 0, active: false },
        { id: 'budget_risk', label: 'Budget risk', count: 0, active: false },
        { id: 'model_rerouted', label: 'Model rerouted', count: 0, active: false }
      ]
    },
    queue: [
      gravityRow('NIE-321', 'Budget Pulse', 'review', 'review', 0.86, ['Awaiting operator input']),
      gravityRow('NIE-312', 'Auth Flow Polish', 'review', 'review', 0.78, ['Needs review']),
      gravityRow('NIE-304', 'Transcript Ledger', 'warning', 'warning', 0.62, ['Stalled waiting']),
      gravityRow('NIE-300', 'Chatty', 'focus', 'focus', 0.55, ['Recommended focus'], true),
      gravityRow('NIE-301', 'Workspace Verify', 'running', 'running', 0.32, ['Active and progressing']),
      gravityRow('NIE-298', 'Forensics Export', 'running', 'running', 0.24, ['Active and progressing'])
    ],
    focus: {
      issue_id: 'issue-1',
      issue_identifier: 'NIE-300',
      title: 'Chatty',
      run_attempt: 2,
      thread_id: 'thread_01JX7',
      session_id: 'session-300',
      workspace_path: '/tmp/symphony/NIE-300',
      branch: 'feature/NIE-300',
      pr_links: [],
      tracker_url: 'https://linear.app/issue/NIE-300',
      durable_run_key: 'thread_01JX7'
    },
    lens: {
      ring_tone: 'blue',
      current_message: {
        message_id: 'msg-NIE-300-1',
        role: 'assistant',
        excerpt: 'I will continue the analysis on the transcript ledger and confirm the next safe step before resuming. The current strategy is to verify the workspace state.',
        at: '2026-06-04T12:41:28.000Z',
        truncated: false,
        source_ref: 'codex.turnCompleted'
      },
      role_stream: {
        window_size: 12,
        segments: [
          { role: 'assistant', count: 6, tone: 'blue' },
          { role: 'tool', count: 3, tone: 'green' },
          { role: 'user', count: 1, tone: 'violet' },
          { role: 'system', count: 2, tone: 'amber' }
        ]
      },
      events: [
        { id: 'e1', label: 'terminal', category: 'terminal', at: '2026-06-04T12:41:12.000Z', tone: 'blue', icon: 'terminal', summary: 'Ran lint', evidence_ref: 'call-1', detail_endpoint: '/api/v1/issues/NIE-300/diagnostics' },
        { id: 'e2', label: 'git', category: 'git', at: '2026-06-04T12:41:05.000Z', tone: 'blue', icon: 'git-branch', summary: 'Pushed branch', evidence_ref: 'call-2', detail_endpoint: null },
        { id: 'e3', label: 'linear', category: 'linear', at: '2026-06-04T12:40:58.000Z', tone: 'blue', icon: 'square-stack', summary: 'Updated tracker', evidence_ref: 'call-3', detail_endpoint: null },
        { id: 'e4', label: 'build', category: 'build', at: '2026-06-04T12:40:41.000Z', tone: 'blue', icon: 'cube', summary: 'Built artifact', evidence_ref: 'call-4', detail_endpoint: null },
        { id: 'e5', label: 'tests', category: 'tests', at: '2026-06-04T12:40:29.000Z', tone: 'amber', icon: 'beaker', summary: '1 flaky retry', evidence_ref: 'call-5', detail_endpoint: null }
      ],
      context_window: { visible_messages: 120, clipped_messages: 80, redacted_count: 0, limit: 200, scan_budget_state: 'ok' },
      transcript_confidence: { score: 0.92, label: 'high', reasons: ['Detailed transcript loaded', '3 tool calls verified', 'No scan budget exhaustion'] },
      model: { requested: 'claude-opus-4-7', effective: 'claude-opus-4-7', reroute_reason: null }
    },
    interlocks: [
      {
        index: 1,
        id: 'preconditions',
        title: '1 PRECONDITIONS',
        subtitle: 'Verified before send',
        tone: 'green',
        state_label: '4 / 4 verified',
        body: {
          kind: 'preconditions',
          checks: [
            { id: 'workspace_clean', label: 'Workspace clean', ok: true, detail: null, owner: 'workspace-manager', evidence_ref: '/tmp/symphony/NIE-300' },
            { id: 'branch_up_to_date', label: 'Branch up to date', ok: true, detail: null, owner: 'workspace-manager', evidence_ref: 'feature/NIE-300' },
            { id: 'no_conflicting_runs', label: 'No conflicting runs', ok: true, detail: '1 active run · 3 active workers', owner: 'orchestrator', evidence_ref: null },
            { id: 'sla_within_limits', label: 'SLA within limits', ok: true, detail: null, owner: 'observability', evidence_ref: null }
          ]
        }
      },
      {
        index: 2,
        id: 'intent',
        title: '2 SAFE INTERVENTION',
        subtitle: 'Operator intent',
        tone: 'blue',
        state_label: 'Steer: Clarify direction',
        body: { kind: 'intent', intent_capsule: 'Steer: Clarify direction', reason_note_required: true, composer_endpoint: '/api/v1/issues/NIE-300/input' }
      },
      {
        index: 3,
        id: 'preview',
        title: '3 ENDPOINT PREVIEW',
        subtitle: 'What will be sent',
        tone: 'amber',
        state_label: 'Preview (projector-composed)',
        body: { kind: 'preview', method: 'POST', endpoint: '/api/v1/issues/NIE-300/input', body_preview: '{\n  "mode": "steer",\n  "reason_code": "operator_clarify",\n  "reason_note": "<required>",\n  "input": "<operator text>"\n}', truncated: false }
      },
      {
        index: 4,
        id: 'receipt',
        title: '4 AUDIT RECEIPT',
        subtitle: 'Immutable record',
        tone: 'neutral',
        state_label: 'Will create receipt',
        body: { kind: 'receipt', lifecycle: 'preview', receipt_id: 'receipt_8f2a7c', at: null, result: 'Will create receipt on send' }
      }
    ],
    evidence_path: [
      { id: 'thread', label: 'thread', value: 'thread_01JX7', tone: 'green', detail: null, open_endpoint: '/api/v1/threads/thread_01JX7', copy_value: 'thread_01JX7' },
      { id: 'transcript', label: 'transcript', value: 'sessions/01JX7/rollout.jsonl', tone: 'green', detail: null, open_endpoint: '/api/v1/sessions/01JX7/rollout', copy_value: '01JX7' },
      { id: 'api_snapshot', label: 'api snapshot', value: 'snapshot_01JX7.json', tone: 'green', detail: null, open_endpoint: '/api/v1/state', copy_value: '01JX7' },
      { id: 'audit', label: 'audit', value: 'receipt_8f2a7c', tone: 'green', detail: 'Pending creation', open_endpoint: null, copy_value: 'receipt_8f2a7c' }
    ],
    actions: [
      { id: 'steer', label: 'Steer', intent_line: 'Guide agent safely', icon: 'compass', tone: 'blue', enabled: true, disabled_reason: null, destructive: false, api_action: null, last_result: null },
      { id: 'resume', label: 'Resume', intent_line: 'Unblock with input', icon: 'play', tone: 'blue', enabled: false, disabled_reason: 'Run is not blocked', destructive: false, api_action: null, last_result: null },
      { id: 'inspect_evidence', label: 'Inspect Evidence', intent_line: 'Open transcript path', icon: 'document-search', tone: 'green', enabled: true, disabled_reason: null, destructive: false, api_action: null, last_result: null },
      { id: 'export_forensics', label: 'Export Forensics', intent_line: 'Bundle run artifacts', icon: 'download', tone: 'violet', enabled: true, disabled_reason: null, destructive: false, api_action: null, last_result: null },
      { id: 'drain_wait', label: 'Drain: Wait', intent_line: 'Quiesce new work', icon: 'pause', tone: 'amber', enabled: true, disabled_reason: null, destructive: false, api_action: null, last_result: null },
      {
        id: 'more', label: 'More', intent_line: '', icon: 'ellipsis', tone: 'neutral', enabled: true, disabled_reason: null, destructive: false, api_action: null, last_result: null,
        more_items: [
          { id: 'runtime_panels', label: 'Runtime Panels', endpoint: '/api/v1/diagnostics', enabled: true, disabled_reason: null },
          { id: 'event_feed', label: 'Event Feed', endpoint: '/api/v1/events', enabled: true, disabled_reason: null },
          { id: 'project_history', label: 'Project History', endpoint: '/api/v1/history', enabled: true, disabled_reason: null },
          { id: 'diagnostics', label: 'Diagnostics', endpoint: '/api/v1/diagnostics', enabled: true, disabled_reason: null },
          { id: 'raw_json', label: 'Raw JSON', endpoint: '/api/v1/state', enabled: true, disabled_reason: null },
          { id: 'settings', label: 'Settings', endpoint: '/api/v1/workflow/path', enabled: true, disabled_reason: null }
        ]
      }
    ],
    footer: {
      operator: 'niels',
      snapshot_time: '12:41:28',
      local_time: 'Thu 04 Jun 2026',
      api: { icon: 'plug', label: 'API', value: 'Healthy', detail: null, tone: 'green', detail_endpoint: '/api/v1/diagnostics' },
      workers: { icon: 'cpu', label: 'Workers', value: '3 / 3', detail: null, tone: 'green', detail_endpoint: '/api/v1/diagnostics' },
      queues: { icon: 'layers', label: 'Queues', value: '2', detail: '1 blocked · 1 retry', tone: 'amber', detail_endpoint: null }
    },
    missing_capabilities: [
      { id: 'gravity_score', label: 'Backend-authored gravity score', required_for: 'gravity', severity: 'degrades_observability', current_fallback: 'Gravity score is computed by the projector.', implementation_hint: 'Move gravity_score, gravity_band, and gravity_reasons into the orchestrator snapshot.' },
      { id: 'command_preview', label: 'Backend-generated command preview', required_for: 'command_preview', severity: 'blocks_action', current_fallback: 'Endpoint preview is composed by the projector.', implementation_hint: 'Add POST /api/v1/issues/:id/actions/:action/preview.' },
      { id: 'evidence_path_receipts', label: 'Audit receipt query endpoint', required_for: 'audit_receipt', severity: 'degrades_observability', current_fallback: 'Audit cell derives a receipt id from the latest operator_actions entry.', implementation_hint: 'Implement GET /api/v1/audit/receipts/:receiptId.' }
    ]
  };
}

function gravityRow(identifier, title, state, glyph, score, reasons, isFocus = false) {
  return {
    issue_id: identifier,
    issue_identifier: identifier,
    title,
    status_label: reasons[0] ?? state,
    state,
    glyph,
    gravity_score: score,
    gravity_band: score >= 0.7 ? 'urgent' : score >= 0.35 ? 'warning' : 'active',
    gravity_reasons: reasons.map((label, idx) => ({ code: 'reason_' + idx, label, weight: 0.2, evidence_ref: null })),
    recommended_focus_reason: reasons[0] ?? null,
    is_focus: isFocus,
    detail_endpoint: '/api/v1/issues/' + encodeURIComponent(identifier)
  };
}
