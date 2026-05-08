import { describe, expect, it } from 'vitest';

import { renderDashboardClientJs, renderDashboardHtml } from '../../src/api/dashboard-assets';

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

  it('preserves stopped-run recovery loaded before the initial state snapshot', () => {
    const clientJs = renderDashboardClientJs();
    const loadBlock = clientJs.slice(
      clientJs.indexOf('async function loadStoppedRunRecovery()'),
      clientJs.indexOf('function applyPayload(payload, source)')
    );
    const applyBlock = clientJs.slice(
      clientJs.indexOf('function applyPayload(payload, source)'),
      clientJs.indexOf('function updateRuntimeClock()')
    );

    expect(clientJs).toContain('stoppedRunRecoveryPayload: null');
    expect(clientJs).toContain('function normalizeStoppedRunRecoveryPayload(recovery)');
    expect(clientJs).toContain('function mergeStoppedRunRecoveryPayload(payload, recoveryPayload)');
    expect(loadBlock).toContain('state.stoppedRunRecoveryPayload = normalizeStoppedRunRecoveryPayload(recovery);');
    expect(loadBlock).toContain('renderStoppedRunRecovery(state.stoppedRunRecoveryPayload);');
    expect(applyBlock).toContain('state.stoppedRunRecoveryLoaded && state.stoppedRunRecoveryPayload');
    expect(applyBlock).toContain('payload = mergeStoppedRunRecoveryPayload(payload, state.stoppedRunRecoveryPayload);');
    expect(applyBlock).not.toContain('state.stoppedRunRecoveryLoaded && state.lastGoodPayload');
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
