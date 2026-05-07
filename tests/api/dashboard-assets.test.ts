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
    expect(clientJs).toContain("renderTimelineLane('Phase'");
    expect(clientJs).toContain("appendDefinitionValue(elements.threadBlockerCard, 'classification'");
    expect(clientJs).toContain('diagnostics.capability_warnings');
    expect(clientJs).toContain('recommended_recovery_action');
    expect(clientJs).toContain('entry.current_blocker_class');
    expect(clientJs).toContain('entry.time_since_progress');
    expect(clientJs).toContain('entry.last_successful_step');
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
