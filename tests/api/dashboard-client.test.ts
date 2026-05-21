import { describe, expect, it } from 'vitest';

import {
  formatApiError,
  formatElapsedMs,
  formatNumber,
  formatOverviewTokenValue,
  formatTokenBreakdown,
  getActionRequiredLabel,
  getProgressSignalLabel,
  getRetryStateLabel,
  getTokenConfidenceLabel,
  getTurnControlLabel
} from '../../src/api/dashboard-client/formatting';
import { getConnectionClass, getConnectionLabel } from '../../src/api/dashboard-client/connection';
import { resolveDashboardClientConstants } from '../../src/api/dashboard-client/config';

describe('dashboard browser client modules', () => {
  it('normalizes dashboard client config defaults and minimum values', () => {
    expect(
      resolveDashboardClientConstants({
        dashboard_enabled: undefined,
        refresh_ms: 10,
        render_interval_ms: 10,
        phase_stale_warn_ms: 10
      } as never).safeConfig
    ).toEqual({
      dashboard_enabled: true,
      refresh_ms: 500,
      render_interval_ms: 250,
      phase_stale_warn_ms: 1000
    });

    expect(resolveDashboardClientConstants({ dashboard_enabled: false } as never).safeConfig).toMatchObject({
      dashboard_enabled: false,
      refresh_ms: 4000,
      render_interval_ms: 1000,
      phase_stale_warn_ms: 45000
    });
  });

  it('formats numbers, durations, connection labels, and state labels directly', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(Number.NaN)).toBe('0');
    expect(formatElapsedMs(65000)).toBe('1m 5s');
    expect(formatElapsedMs(Number.NaN)).toBe('n/a');
    expect(getConnectionLabel('streaming')).toBe('Streaming');
    expect(getConnectionClass('polling')).toBe('badge badge-polling');
    expect(getTurnControlLabel('blocked_manual_resume')).toBe('Manual Resume Required');
    expect(getProgressSignalLabel('stalled_waiting')).toBe('Stalled Waiting');
    expect(getRetryStateLabel({ due_state: 'overdue' })).toBe('Retry Overdue');
    expect(getTokenConfidenceLabel('observed_live')).toBe('Live');
  });

  it('keeps aggregate-only token split behavior importable', () => {
    expect(
      formatOverviewTokenValue(
        {
          codex_totals: {
            token_split_status: 'aggregate_only',
            input_tokens: 0
          }
        },
        'input_tokens',
        'Split unavailable'
      )
    ).toBe('Split unavailable');

    expect(
      formatTokenBreakdown(
        {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 321,
          token_split_status: 'aggregate_only'
        },
        'codex_home_state_sqlite'
      )
    ).toContain('Split unavailable');
  });

  it('formats action-required labels and API errors without the generated asset', () => {
    expect(resolveDashboardClientConstants({} as never).actionRequiredReasonLabels.missing_tool_output_recovery_exhausted).toBe(
      'Missing Tool Output Recovery Exhausted'
    );
    expect(getActionRequiredLabel(null)).toBe('unknown');
    expect(formatApiError({ error: { code: 'bad_request', message: 'Bad request' } }, 'Request failed')).toBe(
      'bad_request: Bad request'
    );
    expect(formatApiError({ error: { message: 'Unavailable' } }, 'Request failed')).toBe('Unavailable');
    expect(formatApiError(null, 'Request failed')).toBe('Request failed');
  });
});
